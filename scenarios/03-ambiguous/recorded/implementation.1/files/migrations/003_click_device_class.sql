-- 003: coarse device class per click.
-- Clicks recorded before this migration have no class and are reported as 'unknown'.
-- Only the class is stored. The User-Agent header it is derived from is never persisted.

ALTER TABLE click_events
  ADD COLUMN device_class TEXT NOT NULL DEFAULT 'unknown'
  CHECK (device_class IN ('desktop', 'mobile', 'tablet', 'bot', 'unknown'));
