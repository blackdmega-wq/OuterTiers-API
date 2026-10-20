-- Preserve whether a punishment expires or remains appealable after its date.
-- Existing rows remain NULL and use their stored expires_at as the legacy expiry.
ALTER TABLE punishments ADD COLUMN expiry_mode TEXT;
