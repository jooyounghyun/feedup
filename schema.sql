-- FeedUp D1 스키마. Cloudflare D1 콘솔에 그대로 붙여넣고 실행하세요.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS docs (
  col TEXT NOT NULL,
  id TEXT NOT NULL,
  owner TEXT,
  player TEXT,
  coach TEXT,
  data TEXT NOT NULL,
  updated INTEGER NOT NULL,
  PRIMARY KEY (col, id)
);
CREATE INDEX IF NOT EXISTS idx_docs_owner ON docs(col, owner);
CREATE INDEX IF NOT EXISTS idx_docs_player ON docs(col, player);
CREATE INDEX IF NOT EXISTS idx_docs_coach ON docs(col, coach);
CREATE TABLE IF NOT EXISTS ai_usage (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
