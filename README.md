# waagent — multi-tenant WhatsApp AI assistant

A small SaaS where **multiple users** sign up, link **their own** WhatsApp number
(via a QR code shown in the browser — *not* the WhatsApp Business API), bring
**their own** Claude API key, and let an AI agent auto-reply to their clients.

> ⚠️ **Heads up:** This connects through WhatsApp Web using an unofficial library
> ([Baileys](https://github.com/WhiskeySockets/Baileys)). Automating a personal
> WhatsApp account is against WhatsApp's Terms of Service and carries a (small but
> real) ban risk. Each user should use a number they can afford to risk and keep
> auto-replies human and low-volume. New accounts default to **reply mode "off"**
> (log only) so nothing is sent until the user opts in.

## What's included

- **Accounts & login** — open email/password signup, bcrypt-hashed passwords,
  JWT session cookie (httpOnly).
- **Per-user isolation** — each user has their own settings, conversation
  memory, and a dedicated WhatsApp session. No data crosses tenants.
- **Bring your own key** — each user pastes their Anthropic API key in settings;
  it's stored **AES-256-GCM encrypted** at rest. You carry zero AI cost.
- **Web dashboard** — link/unlink WhatsApp (QR in the browser), configure the
  agent (identity, model, reply mode, allow/blocklist, business hours).
- **The agent** — Claude (default `claude-opus-4-8`) drafts professional replies,
  escalates to the user when unsure, and stays silent on spam.
- **Google Drive** — scaffolded as a per-user Phase 2 stub.

## Architecture

```
Browser (dashboard)
   │  signup / login (JWT cookie)         ┌───────────────────────────┐
   ├─────────────────────────────────────►│  Express API (src/web)    │
   │  link WhatsApp (poll QR + status)    │  auth · settings · wa     │
   │                                      └───────────┬───────────────┘
   │                                                  │
   ▼                                                  ▼
 PostgreSQL  ◄── users, settings, messages   Session manager (src/wa)
 (src/db)        (encrypted API keys)         one Baileys socket / user
                                                      │
 each user's WhatsApp ──QR link──────────────────────┘
                                              messages → per-user handler → Claude
```

- `src/web/` — Express server, routes, and the static dashboard (`public/`).
- `src/auth/` — password hashing, API-key encryption, JWT sessions.
- `src/db/` — PostgreSQL pool, schema, and query modules.
- `src/wa/` — multi-tenant session manager (one socket per user) + message handler.
- `src/agent/` — the Claude brain (parameterised per user) + Drive stub.
- `src/services/userConfig.js` — resolves a user's stored settings into runtime config.

## Setup

Requires **Node.js 20+** and a **PostgreSQL** database.

```bash
npm install
cp .env.example .env
# edit .env: set DATABASE_URL, SESSION_SECRET, ENCRYPTION_KEY
# generate secrets with:  openssl rand -hex 32
```

The schema is created automatically on first boot (or run `npm run migrate`).

```bash
npm start
```

Open <http://localhost:3000>, create an account, then:

1. **Settings** → paste your Anthropic API key (from
   <https://console.anthropic.com/>) and fill in your name/business.
2. **Your WhatsApp** → click *Link / Connect* and scan the QR with
   **WhatsApp → Settings → Linked devices → Link a device**.
3. Leave reply mode on **Off** at first to watch it log incoming messages, then
   switch to **Auto** when you're happy (consider setting an allowlist first).

## Environment variables

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string (append `?sslmode=require` for most managed providers). |
| `SESSION_SECRET` | Signs login cookies. Long random string. |
| `ENCRYPTION_KEY` | Encrypts users' API keys at rest. Long random string. **Changing it invalidates all stored keys.** |
| `PORT` | Web server port (default 3000). |
| `COOKIE_SECURE` | `true` when served over HTTPS. |
| `AUTH_ROOT` | Where per-user WhatsApp sessions are stored on disk (default `./auth`). |
| `DEFAULT_MODEL` | Model offered to new users (default `claude-opus-4-8`). |

## Data model (PostgreSQL)

- `users` — id, email, bcrypt password hash.
- `user_settings` — identity, **encrypted** Anthropic key, model, reply rules.
- `messages` — per-user, per-chat conversation memory.
- `chat_state` — last-reply timestamps for rate limiting.

## Security notes

- Passwords are bcrypt-hashed; API keys are AES-256-GCM encrypted. Keep
  `SESSION_SECRET` and `ENCRYPTION_KEY` safe and out of source control.
- Each user's linked WhatsApp session lives under `auth/<userId>/` (gitignored).
  Anyone with that folder can act as that user's WhatsApp — protect the host.
- Before going to production: serve over HTTPS (`COOKIE_SECURE=true`), add rate
  limiting on the auth endpoints, email verification, and database backups.

## Scaling note

The session manager runs every user's WhatsApp socket **in this one Node
process**, which is great up to a few hundred active users on a single server.
Beyond that, shard users across worker processes/instances (e.g. by user-id hash)
and move WhatsApp auth state into shared storage. The DB layer is already
multi-instance-safe.

## Roadmap

- [x] Multi-tenant accounts, login, per-user WhatsApp + settings
- [x] Bring-your-own encrypted Claude API key
- [ ] Email verification + password reset
- [ ] Google Drive: send requested documents, upload received files (per user)
- [ ] Usage dashboard & billing
