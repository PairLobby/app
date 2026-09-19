import {betterAuth} from 'better-auth';

export function createAuth(env: Env, ctx: ExecutionContext) {
    if (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32) {
        throw new Error('Authentication is not configured');
    }
    const send = (to: string, subject: string, url: string) => {
        ctx.waitUntil(
            env.EMAIL.send({
                from: {email: 'accounts@pairlobby.com', name: 'PairLobby'},
                to,
                subject,
                html: `<p>${subject}</p><p><a href="${url.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')}">Continue to PairLobby</a></p><p>If you did not request this, ignore this email.</p>`,
                text: `${subject}\n\n${url}\n\nIf you did not request this, you can ignore this email.`
            }).catch(() => {
                console.error('account_email_delivery_failed');
            })
        );
    };
    return betterAuth({
        database: env.DB,
        secret: env.BETTER_AUTH_SECRET,
        baseURL: env.APP_ORIGIN,
        trustedOrigins: [env.APP_ORIGIN],
        emailAndPassword: {
            enabled: true,
            minPasswordLength: 12,
            requireEmailVerification: true,
            revokeSessionsOnPasswordReset: true,
            sendResetPassword: async ({user, url}) => {
                send(user.email, 'Reset your PairLobby password', url);
            }
        },
        emailVerification: {
            sendOnSignUp: true,
            autoSignInAfterVerification: true,
            sendVerificationEmail: async ({user, url}) => {
                send(user.email, 'Verify your PairLobby email', url);
            }
        },
        session: {expiresIn: 7 * 86400, updateAge: 86400},
        rateLimit: {enabled: true, storage: 'database', window: 60, max: 10},
        advanced: {useSecureCookies: env.APP_ORIGIN.startsWith('https://')}
    });
}
