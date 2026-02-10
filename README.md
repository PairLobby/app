# Parking Backend (Cloudflare Worker)

TypeScript Cloudflare Worker backend with JWT auth.

## Endpoints

- `GET /health`
- `POST /auth/signup`
- `POST /auth/login`
- `GET /auth/me`

## Local setup

1. Install dependencies: `npm install`
2. Create local env file: copy `.dev.vars.example` to `.dev.vars`
3. Set `JWT_SECRET` in `.dev.vars`
4. Run dev server: `npm run dev`

## Deploy

1. Set JWT secret in Cloudflare:
   `npx wrangler secret put JWT_SECRET`
2. Deploy:
   `npm run deploy`

## Notes

- Current user storage is in-memory (`src/auth/userStore.ts`) and resets when Worker instance is recycled.
- For production, switch user storage to D1/KV/R2.
