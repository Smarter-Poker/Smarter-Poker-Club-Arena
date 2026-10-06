# tests/a-stats-refresh-steps-around-a-live-hand.law.test.ts

A stats refresh steps around a live hand (2026-10-03): fn_refresh_player_stats locks the existing player_stats rows it will rewrite in key order with FOR UPDATE SKIP LOCKED, upserts only those rows plus keys that do not exist yet, in key order, and retries a block chosen as a deadlock victim up to three times before failing, so the hourly refresh no longer dies against the per-hand player_stats writers; a row a live hand holds keeps its figures until the next run, and nothing about how a figure is computed changes
