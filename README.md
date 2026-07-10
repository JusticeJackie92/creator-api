# Creator Platform API

Security-first backend for a creator monetization platform. **NestJS · TypeScript · Prisma · PostgreSQL · Redis · Socket.IO · NOWPayments (crypto) + PayPal · Cloudinary · Resend.**

Fully compiles (`tsc` clean) and ships with Docker. Auth, media, content gating, payments fulfillment, and realtime messaging are implemented end-to-end; a few clearly-marked seams (2FA verify step, BullMQ workers) are left as documented next steps.

---

## Quick start

```bash
cp .env.example .env      # fill in real secrets — openssl rand -base64 48
docker compose up -d db redis
npm install
npx prisma migrate dev --name init
npm run start:dev          # http://localhost:4000/api/v1  ·  Swagger at /docs
```

Or everything in containers: `docker compose up --build`.

---

## Security architecture (the important part)

### Authentication
| Control | Implementation |
|---|---|
| Password hashing | **Argon2id** (64 MB, t=3, p=4 — OWASP params) |
| Access tokens | JWT, **15 min TTL**, issuer/audience pinned, carries session id |
| Refresh tokens | **256-bit opaque**, stored only as SHA-256 hash, **rotated on every use** |
| Token theft | **Reuse detection**: replaying a rotated token revokes the session + emails the user + audit log |
| Token transport | Refresh token in **signed, httpOnly, Secure, SameSite=strict cookie** scoped to `/auth/refresh` only (XSS + CSRF hardened) |
| Revocation | JWT guard checks the **live session row** — revoking a session kills access tokens instantly, not after expiry |
| Brute force | **Account lockout** (5 fails → 15 min) + per-route throttles (5 logins/min/IP, 5 signups/hr/IP) |
| Enumeration | Login/forgot-password return identical responses & burn identical Argon2 time whether the account exists or not |
| Password reset | Single-use 30-min token (hashed at rest); reset **revokes all sessions** |
| Email verification | Required before login; single-use 24 h token via **Resend** |
| Sessions | Per-device rows, list & revoke endpoints, IDOR-safe scoped updates |
| 2FA | Schema + encrypted TOTP secret field ready; verify step is a marked TODO in `AuthService.login` |

### Platform hardening
- **Fail-closed global auth guard** — every route requires a JWT unless explicitly `@Public()`.
- **Role hierarchy guard** (SUPER_ADMIN > ADMIN > MODERATOR > CREATOR > USER); admins cannot ban admin accounts.
- **Helmet** (CSP restricted to self + Cloudinary, HSTS preload), strict **CORS whitelist**, `trust proxy`.
- **Validation everywhere**: global `whitelist + forbidNonWhitelisted` ValidationPipe (mass-assignment safe), the same DTO validation applied to WebSocket payloads.
- **Fail-fast env validation** — boot refuses weak/missing secrets (all secrets require 32+ chars).
- **Sanitized errors** — clients get a correlation id, never stack traces or SQL.
- **AES-256-GCM** helper for sensitive fields at rest; constant-time comparisons for signatures.
- **Audit log** of security events (login, lockout, token replay, resets, admin actions).
- IDOR-safe data access: every mutation is scoped `WHERE id AND ownerId` — no fetch-then-check races.

### Media (Cloudinary signed direct upload)
1. `POST /media/sign` → server signs `{timestamp, folder: users/{userId}}` — **API secret never leaves the server**, signature can't upload outside the caller's folder.
2. Client uploads **directly** to Cloudinary (files never transit our API).
3. `POST /media/confirm` → server **independently verifies the asset via Cloudinary's Admin API** (never trusts client metadata), enforces format/size allow-lists, runs a `virusScanHook()` seam, then persists only `public_id + metadata`.
4. Delivery: `GET /media/:id/url` returns a **signed authenticated URL only after an entitlement check** (owner / free / active subscriber / purchaser). Locking is server-side, never client-side blurring.

### Payments (NOWPayments crypto + PayPal)
- **Webhooks are the only source of truth** — client "success" redirects never credit anything.
- **NOWPayments IPN** verified with **HMAC-SHA512 over the key-sorted JSON body** (their documented scheme), compared in constant time.
- **PayPal** webhooks verified **server-to-server via PayPal's verify-webhook-signature API** (certificate-based) — no shared secret stored, no local cert parsing. Orders use the v2 Orders API; `CHECKOUT.ORDER.APPROVED` is captured server-side and fulfillment happens on `PAYMENT.CAPTURE.COMPLETED`.
- **Provider-agnostic pending-order design**: before redirecting the buyer we persist a `PENDING` Transaction keyed by our own opaque `orderId` holding the fulfillment contract **and the expected amount**. Providers only echo back that opaque id — we never trust provider-supplied metadata or prices; we look up our record and **verify the amount** before granting access.
- **Fulfilled at most once**: a `PENDING → SUCCEEDED` compare-and-set inside a DB transaction survives concurrent/duplicate deliveries.
- **Replay-proof**: every provider event id recorded in `WebhookEvent` (unique) — duplicates are no-ops.
- **Server-computed prices** — plan/tip amounts always come from the DB, never from the client.
- Integer-cents everywhere, ledger `Transaction` rows, 20 % platform fee split, wallet credits inside DB transactions.

### Realtime (Socket.IO)
- Handshake **requires a valid access JWT** — unauthenticated sockets are disconnected before joining anything.
- Room joins verified against **DB conversation membership**.
- Presence / typing / last-seen live in Redis with TTLs; messages persist in PostgreSQL through the same validated service as REST.

---

## What's implemented

- **Auth**: register, email verify (Resend), login w/ lockout, refresh rotation + reuse detection, logout, forgot/reset password, device-session list/revoke/revoke-all.
- **Users**: me, public profile, profile update (sanitized social links, media ownership checks), block/unblock, follow/unfollow.
- **Creators**: become-creator flow, settings (welcome message, theme), plan upsert per interval (monthly/quarterly/yearly, trials, discounts), earnings dashboard.
- **Media/Vault**: signed upload + verified confirm, folders, move, access (free / subscribers / PPV price), soft-delete trash, cursor-paginated vault, gated delivery URLs.
- **Posts**: text/media/carousel, drafts, scheduling, hashtags, pin, delete; gated creator feed (locked posts leak zero content); likes, bookmarks, comments (entitlement-checked).
- **Subscriptions**: NOWPayments/PayPal checkout creation, webhook fulfillment (buys one interval of access), cancel-at-period-end, billing history.
- **Tips**: checkout, anonymous option, leaderboard (hides anonymous identities), history.
- **Messaging**: REST + gateway — conversations, history, read receipts, delete-for-everyone (1 h window), mute, typing, presence, block enforcement.
- **Notifications**: in-app storage + unread counts (push/email fan-out seam in `NotificationsService.notify`).
- **Admin**: overview metrics, report queue (moderator+), resolve, ban/suspend with session kill + audit, audit-log viewer.
- **Ops**: health checks (DB/Redis), Swagger, multi-stage non-root Dockerfile with healthcheck, docker-compose.

## Deliberately deferred (marked in code)
- 2FA TOTP verify step (`otplib` installed, secret storage encrypted & ready).
- Google/Apple OAuth (schema fields `googleId`/`appleId` ready).
- BullMQ workers (video processing, email queue, renewal sweeps, media cleanup) — `bullmq` installed, hooks marked.
- OneSignal push fan-out.
- Search endpoints, mass messaging, KYC upload flow.

## API map (all under `/api/v1`)
`/auth/*` · `/users/*` · `/creators/*` · `/media/*` · `/posts/*` · `/subscriptions/*` · `/tips/*` · `/messages/*` + `ws://…/ws` · `/notifications/*` · `/admin/*` · `/health` — full interactive docs at **`/docs`**.

## Production checklist
- Generate unique 48-byte secrets for all four secret vars; store in a secrets manager.
- Enable Cloudinary **authenticated/strict delivery** so raw asset URLs can't be guessed.
- Put the API behind TLS (the refresh cookie is `Secure` in production).
- Register webhook endpoints: `/api/v1/payments/webhooks/nowpayments` (NOWPayments IPN) and `/api/v1/payments/webhooks/paypal` (PayPal). Set `PAYPAL_WEBHOOK_ID` to the id PayPal assigns your webhook.
- Verify a sending domain in Resend and set `MAIL_FROM` accordingly.
- Set `ENABLE_SWAGGER=false` (default in production).
