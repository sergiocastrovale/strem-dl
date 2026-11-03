CREATE TABLE favorites (
  url TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL
);

CREATE TABLE url_history (
  url TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  last_used_at INTEGER NOT NULL
);
