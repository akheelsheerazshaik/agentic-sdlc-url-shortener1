-- 002: optional link expiry.
-- NULL means the link never expires, so every existing link keeps working unchanged.

ALTER TABLE links ADD COLUMN expires_at TEXT;   -- ISO-8601, UTC
