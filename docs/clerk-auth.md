# Clerk auth — dashboard configuration

Account auth is a **purely additive** Clerk integration: anonymous play, guest identity, and
Local 1v1 are unchanged whether or not Clerk is configured. This document is the operator
checklist for the Clerk Dashboard settings that the app code assumes. Nothing here requires a
code change — the frontend (`frontend/src/auth.jsx`, `identityBridge.js`) and backend
(`backend/app/auth/`) already consume these settings.

## 1. Enable Clerk in each environment

Set the publishable key so the SPA mounts `<ClerkProvider>`:

```
# frontend/.env.development / .env.production (or the deploy environment)
VITE_CLERK_PUBLISHABLE_KEY=<clerk-publishable-key>   # leave blank for a fully anonymous build
```

Backend resource-server verification (already documented in the root `README.md`):

```
ELQ_CLERK_ISSUER=https://<your-subdomain>.clerk.accounts.dev
ELQ_CLERK_JWKS_URL=https://<your-subdomain>.clerk.accounts.dev/.well-known/jwks.json
ELQ_CLERK_SECRET_KEY=<clerk-secret-key>             # optional, for Backend API calls
ELQ_CLERK_WEBHOOK_SECRET=<clerk-webhook-secret>     # Svix signing secret for Clerk webhooks
ELQ_CLERK_AUTHORIZED_PARTIES=https://app.example.com   # optional azp allow-list
```

## 2. Require a unique username (email **and** social sign-ups)

**Dashboard → User & Authentication → Username**

1. Toggle **Username** on and set it to **Required**.
2. Clerk enforces uniqueness automatically and surfaces collisions ("That username is taken")
   inside the prebuilt `<SignUp/>` / `<UserProfile/>` flows — no custom validation needed.

Because the app uses Clerk's **prebuilt** components (`<SignUpButton mode="modal">` and
`<UserButton/>`), social/OAuth sign-ups are prompted for the missing username on their first
completion step, exactly like email sign-ups. There is nothing app-side to special-case.

## 3. Expose `username` in the session token (so the backend mirrors it)

The backend JIT-provisions a local `User` from the **verified session-token claims** on first
sign-in (`get_or_create_user_for_claims` in `backend/app/auth/users.py`). Clerk does **not** put
`username` in the session token by default, so add it as a custom claim:

**Dashboard → Sessions → Customize session token → Edit**

```json
{
  "username": "{{user.username}}",
  "email": "{{user.primary_email_address}}",
  "first_name": "{{user.first_name}}",
  "last_name": "{{user.last_name}}",
  "image_url": "{{user.image_url}}"
}
```

The JWT verifier (`backend/app/auth/clerk.py`) returns all of these claims, and the JIT helper
maps `username` → `users.username`, plus email / display name / avatar.

### Mirroring scope

JIT mirroring provisions the first local `User` row. Later Clerk profile changes are mirrored by
the Clerk webhook sync endpoint when `ELQ_CLERK_WEBHOOK_SECRET` is configured. The in-game display
name still reads the **live** Clerk user client-side via `useClerkPrefilledName`, so the "Your
name" field reflects the current username even before a webhook retry updates the local cache.

## 4. Profile view

Signed-in users open **Profile** from the `<UserButton/>` menu, which routes to `/profile`
(`ProfileRoute` in `auth.jsx`). It renders Clerk's prebuilt, path-routed `<UserProfile/>`
showing username, email, display name, connected accounts, and avatar. No dashboard
configuration is required beyond the steps above; Clerk's account-portal settings (e.g. which
fields are editable) apply as-is.

## What stays anonymous

- No publishable key → `<ClerkProvider>` never mounts, `AuthMenu` renders nothing,
  `/profile` redirects home, and REST calls send no `Authorization` header.
- Signed-out users with Clerk enabled behave identically to anonymous builds for gameplay; the
  guest id / guest name in `frontend/src/identity.js` continue to drive matchmaking and name
  prefill.
