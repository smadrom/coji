# Auth (Better Auth)

[[Home]] · related: [[Deployment]] · [[Gotchas]]

Email + password with **bearer sessions** (token in `Authorization: Bearer <token>`), Drizzle adapter over the same Postgres (`db/auth-schema.ts`: user/session/account/verification).

## Mounting (`apps/api/src/modules/auth/routes.ts`)
```ts
.all('/api/auth/*', ({ request }) => auth.handler(request))   // ✅
// NOT .mount('/api/auth', auth.handler)  ← strips the prefix → 404 (see [[Gotchas]])
```
Plus a typed `GET /api/me` → `{ userId }` (401 when unauthenticated). MCP deny-list: `^/api/auth`, `/api/me`.

## Config (`auth.ts`)
```ts
betterAuth({
  baseURL: env.betterAuthUrl,           // MUST be the public origin in prod
  secret: env.betterAuthSecret,         // prod-throws if left at the dev fallback
  database: drizzleAdapter(db, { provider: 'pg', schema: authSchema }),
  emailAndPassword: { enabled: true },
  plugins: [bearer()],
})
```

## "Invalid origin" in the browser
Better Auth validates the request `Origin` against its `baseURL`/trustedOrigins. If `BETTER_AUTH_URL` is unset it defaults to `http://localhost:3001`; a browser at `https://coji.example.com` is then rejected with **Invalid origin** (curl without an Origin header still works, which masks it).
**Fix:** set `BETTER_AUTH_URL=https://coji.example.com` to the exact public browser origin. See [[Gotchas]] and [[Runbook]].

## The ownership guard (`modules/auth/context.ts`)
`requireAuth(headers)` (async) → caller; `assertOwner(resourceUserId, caller)` → `OwnershipError` (**404**, privacy-preserving) / `UnauthenticatedError` (**401**). Used on **every** project-scoped route. Signatures are stable — payments/UI depend on them.

## Test hatch
`AUTH_TEST_HEADER=true` makes `resolveAuth` also accept an `x-user-id` header (no real session). **Off in prod.** A bun test preload enables it so all `app.handle` suites exercise the real guard without a live session or DB.

## Browser URL note
Web `BASE_URL=/api`; auth calls are `/api/auth/*` → effective `/api/api/auth/*` which nginx strips once → `/api/auth/*`. See [[Deployment]] for the nginx proxy detail.
