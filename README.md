# Parking Backend (Cloudflare Worker)

TypeScript Cloudflare Worker backend with JWT auth and Cloudflare KV storage.

## Endpoints

- `GET /health`
- `POST /auth/signup`
- `POST /auth/login`
- `GET /auth/me`
- `PATCH /profile`
- `POST /profile/payment-method`
- `POST /profile/payout-account`
- `GET /listings?search=<query>`
- `POST /listings`
- `GET /listings/:id`
- `GET /bookings`
- `POST /bookings`
- `POST /bookings/:id/cancel`

## Local setup

1. Install dependencies: `npm install`
2. Create KV namespaces:
   - `npx wrangler kv namespace create USERS`
   - `npx wrangler kv namespace create USERS --preview`
3. Put returned IDs in `wrangler.jsonc` under `kv_namespaces` with binding `USERS`
4. Create local env file: copy `.dev.vars.example` to `.dev.vars`
5. Set `JWT_SECRET` in `.dev.vars`
6. Run dev server: `npm run dev`

## Deploy

1. Ensure `wrangler.jsonc` has the `USERS` KV binding configured.
2. Set JWT secret in Cloudflare:
   `npx wrangler secret put JWT_SECRET`
3. Deploy:
   `npm run deploy`

## Notes

- User, listing, and booking records are persisted in KV under dedicated key prefixes.
- Booking payment status starts as `scheduled` and is intended to be captured when parking starts.
- Cancellation policy implemented:
  - `>=2h` before start: no penalty
  - `<2h` before start: `10%` penalty withheld
