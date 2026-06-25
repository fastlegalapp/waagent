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
  anthropic_api_key_enc  TEXT,                          -- AES-GCM encrypted, NULL until set
  anthropic_model        TEXT NOT NULL DEFAULT 'claude-opus-4-8',
  reply_mode             TEXT NOT NULL DEFAULT 'off',   -- 'auto' | 'off'
  allowlist              TEXT NOT NULL DEFAULT '',      -- comma-separated numbers
  blocklist              TEXT NOT NULL DEFAULT '',
  ignore_groups          BOOLEAN NOT NULL DEFAULT true,
  min_interval_seconds   INTEGER NOT NULL DEFAULT 2,
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
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS messages_user_chat_idx
  ON messages (user_id, chat_id, id);

-- Last-reply timestamps for per-chat rate limiting.
CREATE TABLE IF NOT EXISTS chat_state (
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id       TEXT NOT NULL,
  last_reply_at BIGINT NOT NULL DEFAULT 0,              -- epoch millis
  PRIMARY KEY (user_id, chat_id)
);
