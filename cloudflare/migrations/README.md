# Cloudflare D1 migrations

Run `001_player_name_history_backfill.sql` once against the production D1
database, outside a Worker request and before deploying the Worker change. It
creates the history table and indexes, then backfills current player names. It
is safe to rerun.

Run `002_hot_path_indexes.sql` once against the production D1 database before
deploying the API optimization. It creates the presence table if needed and
adds indexes for presence cleanup and common public lookups. It is safe to rerun.

The Worker continues recording new names during normal updates; it no longer
rescans every player when a cold isolate receives its first request.
