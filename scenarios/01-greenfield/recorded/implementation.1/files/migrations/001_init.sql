-- 001: links and click events.
-- Applied migrations are immutable: the migrator stores a checksum and refuses to start if a file changes.

CREATE TABLE links (
  code        TEXT    PRIMARY KEY,
  target_url  TEXT    NOT NULL,
  created_at  TEXT    NOT NULL,              -- ISO-8601, UTC
  click_count INTEGER NOT NULL DEFAULT 0     -- running total, updated in the same transaction as click_events
) STRICT, WITHOUT ROWID;

CREATE TABLE click_events (
  id            INTEGER PRIMARY KEY,
  code          TEXT    NOT NULL REFERENCES links(code) ON DELETE CASCADE,
  clicked_at    TEXT    NOT NULL,            -- ISO-8601, UTC
  referrer_host TEXT                         -- host only; never the full referrer URL
) STRICT;

CREATE INDEX idx_click_events_code_time ON click_events (code, clicked_at);
