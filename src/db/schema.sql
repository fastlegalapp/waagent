-- waagent schema (PostgreSQL)
-- Safe to run repeatedly: all statements use IF NOT EXISTS.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id                UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  owner_name             TEXT NOT NULL DEFAULT '',
  business_name          TEXT NOT NULL DEFAULT '',
  business_description   TEXT NOT NULL DEFAULT '',
  persona_style          TEXT NOT NULL DEFAULT 'friendly',  -- how it should chat
  persona_custom         TEXT NOT NULL DEFAULT '',          -- owner's own how-to-talk notes
  faqs                   TEXT NOT NULL DEFAULT '[]',        -- JSON [{q,a}] canned answers the agent rephrases
  payment_qr             TEXT NOT NULL DEFAULT '',          -- data URL of the owner's payment QR image
  learned_style          TEXT NOT NULL DEFAULT '',          -- AI-learned summary of how the owner talks
  learned_style_at       TIMESTAMPTZ,                       -- when it last learned
  provider               TEXT NOT NULL DEFAULT 'anthropic', -- 'anthropic' | 'deepseek'
  anthropic_api_key_enc  TEXT,                          -- AES-GCM encrypted, NULL until set
  anthropic_model        TEXT NOT NULL DEFAULT 'claude-opus-4-8',
  deepseek_api_key_enc   TEXT,                          -- AES-GCM encrypted, NULL until set
  deepseek_model         TEXT NOT NULL DEFAULT 'deepseek-chat',
  reply_mode             TEXT NOT NULL DEFAULT 'off',   -- 'auto' | 'off'
  allowlist              TEXT NOT NULL DEFAULT '',      -- comma-separated numbers
  blocklist              TEXT NOT NULL DEFAULT '',
  ignore_groups          BOOLEAN NOT NULL DEFAULT true,
  min_interval_seconds   INTEGER NOT NULL DEFAULT 2,
  reply_delay_min_seconds INTEGER NOT NULL DEFAULT 2,  -- human-like pause before replying
  reply_delay_max_seconds INTEGER NOT NULL DEFAULT 6,
  followups_enabled      BOOLEAN NOT NULL DEFAULT false,    -- nudge clients who go quiet
  followups_hours        INTEGER NOT NULL DEFAULT 24,       -- after this many hours of silence
  business_hours_start   INTEGER,                       -- 0-23, NULL = always on
  business_hours_end     INTEGER,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-chat conversation memory.
CREATE TABLE IF NOT EXISTS messages (
  id         BIGSERIAL PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id    TEXT NOT NULL,
  role       TEXT NOT NULL,                             -- 'user' | 'assistant'
  content    TEXT NOT NULL,
  source     TEXT,                                      -- 'client' | 'owner' | 'bot'
  wa_msg_id  TEXT,                                      -- WhatsApp message id (dedupe), NULL for internal
  ts         BIGINT NOT NULL DEFAULT 0,                 -- WhatsApp message timestamp (epoch seconds)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS messages_user_chat_idx
  ON messages (user_id, chat_id, id);
-- (The unique (user_id, wa_msg_id) index for history dedupe is created
--  separately and tolerantly in migrate.js.)

-- User-defined data lists (products, services, customers, leads, EMI schedules,
-- anything) the agent can look things up in and send reminders from.
CREATE TABLE IF NOT EXISTS data_lists (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL,
  instructions         TEXT NOT NULL DEFAULT '',  -- how the agent should use this list
  reminder_enabled     BOOLEAN NOT NULL DEFAULT false,
  reminder_date_field  TEXT NOT NULL DEFAULT '',  -- which field holds the due date
  reminder_phone_field TEXT NOT NULL DEFAULT '',  -- which field holds the phone number
  reminder_template    TEXT NOT NULL DEFAULT '',  -- message; supports {field} placeholders
  reminder_days_before INTEGER NOT NULL DEFAULT 0, -- send this many days before the due date
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Rows within a list. Free-form fields so any industry/shape fits.
CREATE TABLE IF NOT EXISTS data_items (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id          UUID NOT NULL REFERENCES data_lists(id) ON DELETE CASCADE,
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fields           JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_reminded_at TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS data_items_list_idx ON data_items (list_id);
CREATE INDEX IF NOT EXISTS data_items_user_idx ON data_items (user_id);

-- CRM: one row per person who has contacted the owner on WhatsApp. Leads are
-- captured automatically and move through a pipeline (new → contacted →
-- qualified → customer / lost). Auto-converted to "customer" when they order/pay.
CREATE TABLE IF NOT EXISTS crm_contacts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  phone           TEXT NOT NULL,                       -- normalized digits
  chat_id         TEXT NOT NULL DEFAULT '',            -- canonical chat key (phone JID) to message them
  name            TEXT NOT NULL DEFAULT '',
  stage           TEXT NOT NULL DEFAULT 'new',         -- new|contacted|qualified|customer|lost
  source          TEXT NOT NULL DEFAULT 'whatsapp',
  notes           TEXT NOT NULL DEFAULT '',
  value           TEXT NOT NULL DEFAULT '',            -- deal/order value, free-form
  tags            TEXT NOT NULL DEFAULT '',
  msg_count       INTEGER NOT NULL DEFAULT 0,
  auto_stage      BOOLEAN NOT NULL DEFAULT true,       -- false once the owner sets the stage by hand
  last_message_at TIMESTAMPTZ,
  converted_at    TIMESTAMPTZ,                         -- when they became a customer
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, phone)
);
CREATE INDEX IF NOT EXISTS crm_contacts_user_idx ON crm_contacts (user_id, stage);

-- Team: staff accounts attached to an owner's workspace. Matching is by the
-- staff account's email; role gates what they can do (operator = day-to-day
-- work, viewer = read-only).
CREATE TABLE IF NOT EXISTS team_members (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email      TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'operator',    -- 'operator' | 'viewer'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner_id, email)
);
CREATE INDEX IF NOT EXISTS team_members_email_idx ON team_members (email);

-- Billing: successful payments (Razorpay), one row per capture. paid_until on
-- user_settings is the single source of truth for access.
CREATE TABLE IF NOT EXISTS billing_payments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider     TEXT NOT NULL DEFAULT 'razorpay',
  payment_id   TEXT NOT NULL,                       -- razorpay payment id (dedupe)
  order_id     TEXT NOT NULL DEFAULT '',
  plan         TEXT NOT NULL,                       -- 'monthly' | 'yearly'
  amount_paise BIGINT NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, payment_id)
);
CREATE INDEX IF NOT EXISTS billing_payments_user_idx ON billing_payments (user_id);

-- Last-reply timestamps for per-chat rate limiting.
CREATE TABLE IF NOT EXISTS chat_state (
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id        TEXT NOT NULL,
  last_reply_at  BIGINT NOT NULL DEFAULT 0,              -- epoch millis (we/owner replied)
  last_client_at BIGINT NOT NULL DEFAULT 0,              -- epoch millis (client last messaged)
  followup_done  BOOLEAN NOT NULL DEFAULT false,         -- follow-up already sent this round
  PRIMARY KEY (user_id, chat_id)
);

-- Migrations for existing deployments (idempotent).
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'anthropic';
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS deepseek_api_key_enc TEXT;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS deepseek_model TEXT NOT NULL DEFAULT 'deepseek-chat';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS wa_msg_id TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS ts BIGINT NOT NULL DEFAULT 0;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS persona_style TEXT NOT NULL DEFAULT 'friendly';
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS persona_custom TEXT NOT NULL DEFAULT '';
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS faqs TEXT NOT NULL DEFAULT '[]';
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS payment_qr TEXT NOT NULL DEFAULT '';
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS reply_delay_min_seconds INTEGER NOT NULL DEFAULT 2;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS reply_delay_max_seconds INTEGER NOT NULL DEFAULT 6;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS learned_style TEXT NOT NULL DEFAULT '';
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS learned_style_at TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS followups_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS followups_hours INTEGER NOT NULL DEFAULT 24;
ALTER TABLE chat_state ADD COLUMN IF NOT EXISTS last_client_at BIGINT NOT NULL DEFAULT 0;
ALTER TABLE chat_state ADD COLUMN IF NOT EXISTS followup_done BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS crm_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS crm_auto_convert BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS crm_templates TEXT NOT NULL DEFAULT '{}';
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'trial';
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS paid_until TIMESTAMPTZ;
ALTER TABLE chat_state ADD COLUMN IF NOT EXISTS paused_until BIGINT NOT NULL DEFAULT 0;
ALTER TABLE data_items ADD COLUMN IF NOT EXISTS photo TEXT NOT NULL DEFAULT '';
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS webhook_url TEXT NOT NULL DEFAULT '';
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS webhook_secret TEXT NOT NULL DEFAULT '';
