CREATE TABLE review_links (
  id TEXT PRIMARY KEY NOT NULL,
  owner TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  version_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX review_link_owner ON review_links(owner, project_id);
CREATE TABLE review_visitors (
  id TEXT PRIMARY KEY NOT NULL,
  link_id TEXT NOT NULL REFERENCES review_links(id),
  token_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX review_visitor_link ON review_visitors(link_id);
CREATE TABLE review_rate_limits (
  key TEXT PRIMARY KEY NOT NULL,
  window INTEGER NOT NULL,
  count INTEGER NOT NULL
);
