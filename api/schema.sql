-- Run this once in the Neon SQL Editor.
CREATE TABLE IF NOT EXISTS student_usernames (
  username VARCHAR(20) PRIMARY KEY,
  uid VARCHAR(128) NOT NULL UNIQUE,
  email VARCHAR(320) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT username_format CHECK (username ~ '^[a-z0-9_]{3,20}$')
);

CREATE INDEX IF NOT EXISTS student_usernames_uid_idx
  ON student_usernames (uid);

-- Weekly full-length UTME mocks published by authorised administrators.
CREATE TABLE IF NOT EXISTS published_mocks (
  id BIGSERIAL PRIMARY KEY,
  title VARCHAR(120) NOT NULL,
  field VARCHAR(20) NOT NULL CHECK (field IN ('Medical', 'Engineering')),
  questions JSONB NOT NULL,
  created_by_uid VARCHAR(128) NOT NULL,
  created_by_email VARCHAR(320) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS published_mocks_published_at_idx
  ON published_mocks (published_at DESC);
