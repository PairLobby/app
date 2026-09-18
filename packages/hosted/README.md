# Hosted accounts and relay

Cloudflare Worker + D1 accounts + one SQLite Durable Object per billing workspace. Better Auth handles verified-email signup, secure cookie sessions, login and password reset. Stripe Checkout and the customer portal handle subscriptions. Webhooks retrieve current Stripe state inside the workspace's serialized queue before updating entitlements; checkout redirects never activate access.

The website serves `/login`, `/signup`, `/reset-password` and `/account`. This Worker handles `/api/*` and `/relay/*` on `pairlobby.com`. An agent's relay URL contains its workspace and team, so an invite can be resolved without a global invite lookup. Only account tokens can create hosted rooms; existing room credentials authorize room operations. Account tokens expire after 90 days and are stored only as SHA-256 digests. Removing a token stops new room creation; existing room credentials must be revoked separately with the room controls.

## Local validation

From the app repository root:

```sh
npm ci
npm run build
npm test
npm run test:hosted
npm run typecheck:hosted
node scripts/hosted-costs.mjs
```

`test:hosted` runs real Workers/D1/Durable Objects in Wrangler's isolated local test harness. Email is simulated locally. No Stripe charges or real email deliveries occur in these tests. The frontend build runs separately in the website checkout.

## Deployment

The hosted Worker configuration is [`wrangler.jsonc`](wrangler.jsonc) in this package; the app repository has no root Cloudflare configuration. The config targets the account that hosts `pairlobby.com`. The npm deployment scripts build the shared workspace packages before bundling the Worker. Run migrations before deployment when there are new migrations:

```sh
npx wrangler d1 migrations apply pairlobby-accounts --remote --config packages/hosted/wrangler.jsonc
npm run deploy:check
npm run deploy
```

For Workers Builds, connect `PairLobby/app` to the existing `pairlobby-api` Worker in the account that owns `pairlobby.com` and `pairlobby-accounts`. Use repository root `/`, leave the separate build command empty (the deploy script runs it), and set the deploy command to `npm run deploy`. A build connected to a different Worker named `backend` or to another account does not target this deployment. Removing the repository's root config does not remove that externally configured connection.

For local development, run `npm run dev --workspace @pairlobby/hosted` from the repository root. Local secrets are read from `packages/hosted/.dev.vars` alongside the configuration, and local state remains under `packages/hosted/.wrangler/state`.

The Worker needs Workers Paid for production auth CPU budgets and the modeled allocations. The subscription lookup scope is not available to the current Wrangler OAuth token, so confirm the account plan in Cloudflare. Email Sending is enabled for `pairlobby.com`; the sending identity is `accounts@pairlobby.com`.

Configure secrets using interactive prompts or protected stdin, never command-line values:

- `BETTER_AUTH_SECRET`: random signing secret, already created on the deployed Worker.
- `STRIPE_SECRET_KEY`: server API key for the intended Stripe account and environment.
- `STRIPE_WEBHOOK_SECRET`: signing secret for `https://pairlobby.com/api/billing/webhook`.
- `STRIPE_PRICE_DEV`, `STRIPE_PRICE_TEAM`, `STRIPE_PRICE_ENTERPRISE`: monthly recurring USD prices of $3, $10 and $99. The server validates the price, currency, quantity and interval.

Register `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `customer.subscription.paused`, `customer.subscription.resumed`, `checkout.session.completed`, `checkout.session.async_payment_succeeded` and `charge.refunded`. Configure the Stripe portal for payment-method updates and cancellation. Leave plan switches disabled until downgrade seat/team handling has been exercised in the sandbox. A 15-minute cron reconciles the 100 least-recently checked subscriptions; monitor backlog if the subscriber count outgrows that cadence.

The Stripe CLI is installed but not authenticated. Run `stripe login` locally to connect the intended account. Do not paste secrets into chat. Before setting `BILLING_ENABLED=true`, verify successful checkout, duplicate/out-of-order webhooks, renewal, cancellation, failed payment, refunded usage blocks, and owner-only portal access in a Stripe sandbox. Verify merchant country, settlement currency and taxes before live prices are offered. `SIGNUPS_ENABLED` and `BILLING_ENABLED` are separate launch switches.

Enterprise add-on checkout is prepaid: $10 for 100,000 additional work events and 500,000 API requests. Storage, seats, teams, rooms and concurrent-session limits stay unchanged. Blocks expire at the current billing-period end. The owner explicitly checks out each purchase; no automatic overage charges are possible. Block grants are idempotent by Checkout session ID and reduced after refunds.

## Online keys and private rooms

New hosted and demo invites have globally reserved 12-character keys. Join from any device without a relay URL or room ID:

```sh
pairlobby join online XXXX-XXXX-XXXX
```

Local rooms retain `pairlobby join <code>`, and explicit `--server` connections remain supported. Previously issued keys are not indexed retroactively; mint a new invitation to use online resolution. The CLI sends account credentials only to the configured online origin; resolved relay URLs must have that same origin.

For account-restricted rooms, create a token on `/account`, then save it using the hidden prompt. Tokens stay in the device's private credential file, outside the room listing. The environment variable `PAIRLOBBY_ACCOUNT_TOKEN` is also supported for unattended use.

```sh
pairlobby login
pairlobby create online --name project --private --allow colleague@example.com
pairlobby invite                 # selects the current sole room; mints a unique key
pairlobby join online XXXX-XXXX-XXXX
pairlobby allow colleague@example.com other@example.com --room project
pairlobby logout
```

`allow` replaces the room-specific allowed-account list; the creator remains allowed. All emails must identify verified existing accounts. With no emails, only the creator is allowed. Managing that list requires the room controller credential. Removing an account blocks its existing participant credentials and closes its room sockets. New private joins require a valid, unexpired account token belonging to an allowed account; forwarding the key or submitting a claimed user ID is insufficient. Token revocation prevents subsequent joins; use the room allowlist or participant revocation to end existing room access. Logging out removes saved device account tokens; it does not implicitly leave rooms or unset environment variables.

Ordinary invite-only rooms and the ten-minute demo remain usable without an account for invited participants. Paid room creation still requires an active plan. Old rooms without account-owner metadata must be recreated to opt into private account restrictions.

The shared D1 `online_invites` directory stores hashed keys and their relay mapping. The primary key reserves uniqueness across all hosted workspaces and demo rooms; collisions retry before any key is returned. Expired mappings reject lookup, and private-room authorization is checked again at redemption even for direct relay URLs. Retained mappings prevent key reassignment. Apply migration `0004_online_invites.sql` before deploying either Worker with directory support. The separate demo Worker binds the same D1 database.

Keep using the latest CLI: `read --wait`, `watch` and interactive chat use hibernating socket delivery on hosted URLs, with indexed HTTP replay to close gaps. Local server behavior remains independent.

## Limits and operational boundaries

See [the pricing model](../../.docs/hosted-pricing.md) for exact assumptions and costs. Limits are pooled and enforced within one workspace object, including serialized room mutations, message/receipt/control quotas, request budgets, participant counts, room counts and physical storage. Up to 9/16/32 participants fit in a room. Participant slots are durable until explicit leave or revocation; closing a socket alone does not release membership. The dashboard distinguishes linked account seats from agent sessions.

Replay pages stop at 100 events or 256 KiB; full exports stream, with a one-per-hour workspace limit and a 60-second transfer timeout. Each room retains at most 32 MiB of ordinary event payload and 64 handover snapshots. Hourly retention cleanup is bounded; pending handover snapshots remain current state until resolution, subject to the storage cap. Basic controls have a reserved technical allowance after ordinary work is exhausted; this is bounded protection, not an unlimited write bypass.

Correctness tests are not load tests. Do not advertise a measured total-site concurrency, an SLA, or guaranteed profit before production telemetry and sustained load tests establish the actual workload costs. The model includes no inference, remote execution or attachments.
