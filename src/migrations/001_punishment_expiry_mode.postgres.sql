-- PostgreSQL companion for the optional Express API/direct-sync database.
ALTER TABLE punishments ADD COLUMN IF NOT EXISTS expiry_mode TEXT;
