# waagent — your personal WhatsApp agent

An AI assistant that links to **your own WhatsApp** (via the QR "Linked devices"
flow — *not* the WhatsApp Business API) and replies to clients and runs tasks on
your behalf, powered by Claude.

> ⚠️ **Heads up:** This connects through WhatsApp Web using an unofficial library
> ([Baileys](https://github.com/WhiskeySockets/Baileys)). It is great for a
> personal/solo setup, but automating a personal account is against WhatsApp's
> Terms of Service and carries a (small but real) risk of a ban. Use a number you
> can afford to risk, keep auto-replies human and low-volume, and start in
> `REPLY_MODE=off` to watch it before letting it send anything.

## What it does today (Phase 1)

- Links to your WhatsApp by QR code and stays connected.
- Reads incoming 1:1 client messages.
- Uses Claude to draft and send a professional reply on your behalf.
- **Safeguards built in:**
  - Allowlist / blocklist of contacts.
  - Ignores group chats (configurable).
  - Never replies to your own messages.
  - Min interval between replies per chat (loop/spam guard).
  - Optional business hours → sends a holding message after hours.
  - **Escalation:** when unsure, the agent pings *you* (a message to yourself)
    and sends the client a polite "I'll get back to you" instead of guessing.
  - Remembers each conversation across restarts.

## What's coming (Phase 2)

- **Google Drive:** let the agent fetch a requested document from your Drive and
  send it to the client, and upload documents clients send you. The hooks are
  already in place (`src/tools/drive.js`) but inert until you connect Drive.

## Setup

Requires **Node.js 20+**.

```bash
npm install
cp .env.example .env
# edit .env — at minimum set ANTHROPIC_API_KEY and your owner/business details
```

Get a Claude API key at <https://console.anthropic.com/>.

### First run (recommended: dry run first)

Set `REPLY_MODE=off` in `.env`, then:

```bash
npm start
```

A QR code prints in the terminal. On your phone: **WhatsApp → Settings →
Linked devices → Link a device**, and scan it. The agent will now **log**
incoming messages without sending anything, so you can confirm it sees the right
chats.

When you're happy, set `REPLY_MODE=auto` and restart. Consider setting
`ALLOWLIST` to one or two test numbers first.

## Configuration

All configuration is in `.env` (see `.env.example` for the full annotated list).
Highlights:

| Variable | What it does |
| --- | --- |
| `ANTHROPIC_API_KEY` | Your Claude API key (required). |
| `ANTHROPIC_MODEL` | Model id. Default `claude-opus-4-8`. Use `claude-sonnet-4-6` or `claude-haiku-4-5` for cheaper, faster replies. |
| `OWNER_NAME` / `BUSINESS_NAME` / `BUSINESS_DESCRIPTION` | Identity & context the agent uses when replying. |
| `REPLY_MODE` | `auto` (reply) or `off` (log only). |
| `ALLOWLIST` / `BLOCKLIST` | Contact numbers (country code, digits only). |
| `IGNORE_GROUPS` | Skip group chats (default `true`). |
| `MIN_REPLY_INTERVAL_SECONDS` | Rate limit per chat. |
| `BUSINESS_HOURS_START` / `_END` | Optional after-hours holding message. |

## How it works

```
WhatsApp (your phone)
        │  QR link (WhatsApp Web protocol)
        ▼
  Baileys socket  ──►  message handler  ──►  Claude (agent.js)
   (src/whatsapp.js)   (safeguards,           ├─ replies, or
                        memory, routing)       ├─ escalates to you, or
                                               └─ stays silent
```

- `src/whatsapp.js` — connection, QR, reconnect, send/notify helpers.
- `src/handlers/message.js` — safeguards, business hours, routing.
- `src/agent.js` — the Claude brain (tool-using agent: `find_document`,
  `escalate_to_human`, `do_not_reply`).
- `src/store/memory.js` — per-chat conversation memory (JSON on disk).
- `src/tools/drive.js` — Google Drive integration (Phase 2 stub).

## Security & privacy notes

- Your linked WhatsApp session lives in `auth_info_baileys/` — **never commit
  it** (already in `.gitignore`). Anyone with that folder can act as your
  WhatsApp.
- Conversation history is stored in plain JSON under `data/`. Treat it as
  sensitive client data.
- The agent is instructed never to invent client-specific facts and to escalate
  anything needing real judgement — but you are responsible for reviewing its
  behaviour, especially in a regulated field.

## Roadmap

- [x] Phase 1 — auto-reply to clients with safeguards + escalation
- [ ] Phase 2 — Google Drive: send requested documents, upload received files
- [ ] Phase 3 — richer task handling (scheduling, CRM lookups), per-client notes
