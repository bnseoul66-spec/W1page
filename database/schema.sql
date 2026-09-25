PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT,
  google_sub TEXT UNIQUE,
  role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('member','admin')),
  challenge_start TEXT NOT NULL CHECK(length(challenge_start)=10),
  challenge_days INTEGER NOT NULL DEFAULT 30 CHECK(challenge_days BETWEEN 1 AND 365),
  daily_goal INTEGER NOT NULL DEFAULT 500 CHECK(daily_goal BETWEEN 1 AND 1000000),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS writing_entries (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entry_date TEXT NOT NULL CHECK(length(entry_date)=10),
  character_count INTEGER NOT NULL CHECK(character_count BETWEEN 1 AND 1000000),
  memo TEXT NOT NULL DEFAULT '' CHECK(length(memo)<=2000),
  link TEXT NOT NULL DEFAULT '' CHECK(length(link)<=2048),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id,entry_date)
);
CREATE INDEX IF NOT EXISTS entries_by_date ON writing_entries(entry_date,user_id);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS site_settings (
  id INTEGER PRIMARY KEY CHECK(id=1),
  header TEXT NOT NULL DEFAULT '매일의 작은 기록이, 나를 만듭니다.',
  announcement TEXT NOT NULL DEFAULT '완벽한 글보다 꾸준한 한 줄. 오늘도 나만의 속도로 기록해 보세요.',
  challenge_guide TEXT NOT NULL DEFAULT '30일 동안 매일 글을 쓰고 기록해 보세요. 짧은 메모도, 긴 에세이도 괜찮아요. 중요한 건 다시 쓰는 마음입니다.',
  accent TEXT NOT NULL DEFAULT 'green' CHECK(accent IN ('green','blue','violet')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT OR IGNORE INTO site_settings(id) VALUES(1);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_id TEXT,
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
