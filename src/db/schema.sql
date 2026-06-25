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
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS learned_style TEXT NOT NULL DEFAULT '';
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS learned_style_at TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS followups_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS followups_hours INTEGER NOT NULL DEFAULT 24;
ALTER TABLE chat_state ADD COLUMN IF NOT EXISTS last_client_at BIGINT NOT NULL DEFAULT 0;
ALTER TABLE chat_state ADD COLUMN IF NOT EXISTS followup_done BOOLEAN NOT NULL DEFAULT false;
