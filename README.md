# Parking Backend (Cloudflare Worker)

TypeScript Cloudflare Worker backend with JWT auth and Cloudflare KV (NoSQL) user storage.

## Endpoints

- `GET /health`
- `POST /auth/signup`
- `POST /auth/login`
- `GET /auth/me`

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

- Users are stored in KV under two key spaces:
  - `user:<id>` => full user record JSON
  - `user_email:<email>` => user ID index
- KV is eventually consistent. This is acceptable for MVP auth flows but can allow rare race conditions on concurrent signups with same email.
