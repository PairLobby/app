import Stripe from 'stripe';
import type {Account, WorkspaceRecord} from './accounts';
import {fail, json} from './http';
import {PLANS, type Plan} from './plans';

export function stripeClient(env: Env) {
    if (!env.STRIPE_SECRET_KEY) {
        fail(503, 'Billing is not configured yet');
    }
    return new Stripe(env.STRIPE_SECRET_KEY, {httpClient: Stripe.createFetchHttpClient(), maxNetworkRetries: 2});
}
export function prices(env: Env): Record<Plan, string> {
    return {dev: env.STRIPE_PRICE_DEV, team: env.STRIPE_PRICE_TEAM, enterprise: env.STRIPE_PRICE_ENTERPRISE};
}
export async function checkout(env: Env, workspace: WorkspaceRecord, user: Account, plan: Plan) {
    if (String(env.BILLING_ENABLED) !== 'true') {
        fail(503, 'Subscriptions are not open for purchase yet');
    }
    const stripe = stripeClient(env);
    if (!prices(env)[plan]) {
        fail(503, 'This subscription is not configured');
    }
    const price = await stripe.prices.retrieve(prices(env)[plan]);
    if (
        price.unit_amount !== PLANS[plan].priceCents ||
        price.currency !== env.CURRENCY ||
        price.recurring?.interval !== 'month' ||
        price.recurring.interval_count !== 1 ||
        !price.active
    ) {
        fail(503, 'The billing price does not match the published plan');
    }
    // Existing subscribers use the portal; a second checkout must not double bill.
    if (workspace.subscription_id) {
        const existing = await stripe.subscriptions.retrieve(workspace.subscription_id);
        if (!['canceled', 'incomplete_expired'].includes(existing.status)) {
            fail(409, 'Manage your existing subscription in the billing portal');
        }
    }
    let customer = workspace.customer_id;
    if (!customer) {
        customer = (await stripe.customers.create({email: user.email, name: user.name, metadata: {workspaceId: workspace.id}}, {idempotencyKey: `customer:${workspace.id}`})).id;
        await env.DB.prepare('UPDATE workspaces SET customer_id=? WHERE id=?').bind(customer, workspace.id).run();
    }
    const subscriptions = await stripe.subscriptions.list({customer, status: 'all', limit: 100});
    if (subscriptions.data.some((s) => !['canceled', 'incomplete_expired'].includes(s.status))) {
        fail(409, 'An existing subscription must be managed in the billing portal');
    }
    const open = await stripe.checkout.sessions.list({customer, status: 'open', limit: 10});
    const reusable = open.data.find((s) => s.metadata?.plan === plan);
    if (reusable) {
        return reusable.url;
    }
    for (const old of open.data.filter((s) => s.mode === 'subscription')) await stripe.checkout.sessions.expire(old.id);
    const session = await stripe.checkout.sessions.create(
        {
            customer,
            mode: 'subscription',
            line_items: [{price: prices(env)[plan], quantity: 1}],
            metadata: {plan},
            client_reference_id: workspace.id,
            subscription_data: {metadata: {workspaceId: workspace.id}},
            success_url: `${env.APP_ORIGIN}/account?checkout=complete`,
            cancel_url: `${env.APP_ORIGIN}/account`
        },
        {idempotencyKey: `checkout:${workspace.id}:${plan}:${Math.floor(Date.now() / 1800_000)}`}
    );
    return session.url;
}
export async function portal(env: Env, workspace: WorkspaceRecord) {
    if (!workspace.customer_id) {
        fail(400, 'No billing customer exists yet');
    }
    return (await stripeClient(env).billingPortal.sessions.create({customer: workspace.customer_id, return_url: `${env.APP_ORIGIN}/account`})).url;
}
export async function webhook(request: Request, env: Env) {
    if (!env.STRIPE_WEBHOOK_SECRET) {
        fail(503, 'Billing webhook is not configured');
    }
    const signature = request.headers.get('stripe-signature');
    if (!signature) {
        fail(400, 'Missing webhook signature');
    }
    const stripe = stripeClient(env);
    let event: Stripe.Event;
    try {
        event = await stripe.webhooks.constructEventAsync(await request.text(), signature, env.STRIPE_WEBHOOK_SECRET, 300, Stripe.createSubtleCryptoProvider());
    } catch {
        fail(400, 'Invalid webhook signature');
    }
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
        const checkout = event.data.object as Stripe.Checkout.Session;
        if (checkout.metadata?.kind === 'usage' && checkout.metadata.workspaceId) {
            await env.WORKSPACES.getByName(checkout.metadata.workspaceId).reconcileUsage(checkout.metadata.workspaceId, checkout.id);
        }
        return json({received: true});
    }
    if (event.type === 'charge.refunded') {
        const charge = event.data.object as Stripe.Charge;
        const paymentIntent = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id;
        if (paymentIntent) {
            const sessions = await stripe.checkout.sessions.list({payment_intent: paymentIntent, limit: 1});
            const checkout = sessions.data[0];
            if (checkout?.metadata?.kind === 'usage' && checkout.metadata.workspaceId) {
                await env.WORKSPACES.getByName(checkout.metadata.workspaceId).reconcileUsage(checkout.metadata.workspaceId, checkout.id);
            }
        }
        return json({received: true});
    }
    if (!event.type.startsWith('customer.subscription.')) {
        return json({received: true});
    }
    const subscription = event.data.object as Stripe.Subscription;
    const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id;
    const workspace = await env.DB.prepare('SELECT * FROM workspaces WHERE customer_id=?').bind(customerId).first<WorkspaceRecord>();
    if (!workspace) {
        fail(409, 'Billing customer is not yet linked; retry delivery');
    }
    await env.WORKSPACES.getByName(workspace.id).reconcileBilling(workspace.id, subscription.id, event.id);
    return json({received: true});
}

export async function usageCheckout(env: Env, workspace: WorkspaceRecord, blocks: number) {
    if (String(env.BILLING_ENABLED) !== 'true') {
        fail(503, 'Purchases are not open yet');
    }
    if (workspace.plan !== 'enterprise' || workspace.status !== 'active' || workspace.period_end <= Date.now() || !workspace.customer_id) {
        fail(402, 'An active Enterprise plan is required');
    }
    if (workspace.period_end - Date.now() < 3600_000) {
        fail(409, 'Wait for the new billing period before purchasing a usage block');
    }
    if (!Number.isInteger(blocks) || blocks < 1 || blocks > 10) {
        fail(400, 'Choose between 1 and 10 usage blocks');
    }
    const session = await stripeClient(env).checkout.sessions.create(
        {
            mode: 'payment',
            customer: workspace.customer_id,
            payment_method_types: ['card'],
            expires_at: Math.floor(Date.now() / 1000) + 1800,
            line_items: [
                {
                    price_data: {
                        currency: env.CURRENCY,
                        unit_amount: 1000,
                        product_data: {
                            name: 'PairLobby Enterprise usage block',
                            description: '100,000 work events and 500,000 API calls until the current billing period ends; existing storage limits apply'
                        }
                    },
                    quantity: blocks
                }
            ],
            metadata: {kind: 'usage', workspaceId: workspace.id, period: String(workspace.period_start), blocks: String(blocks)},
            success_url: `${env.APP_ORIGIN}/account?checkout=complete`,
            cancel_url: `${env.APP_ORIGIN}/account`
        },
        {idempotencyKey: `usage:${workspace.id}:${blocks}:${Math.floor(Date.now() / 600_000)}`}
    );
    return session.url;
}
