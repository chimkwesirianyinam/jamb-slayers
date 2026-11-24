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
