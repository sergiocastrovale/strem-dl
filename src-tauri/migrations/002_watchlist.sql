CREATE TABLE watchlist (
  url TEXT NOT NULL,
  source_name TEXT NOT NULL,
  path_key TEXT NOT NULL,
  path TEXT NOT NULL,
  PRIMARY KEY (url, path_key)
);
