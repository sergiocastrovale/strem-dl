CREATE TABLE downloads (
  url TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  source_url TEXT NOT NULL,
  source_name TEXT NOT NULL,
  path TEXT NOT NULL,
  opened_at INTEGER NOT NULL
);
