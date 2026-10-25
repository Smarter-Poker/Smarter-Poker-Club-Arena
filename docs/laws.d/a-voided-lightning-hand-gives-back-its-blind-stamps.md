# tests/a-voided-lightning-hand-gives-back-its-blind-stamps.law.test.ts

A Lightning hand voided before it is dealt gives back the pool-slot blind stamps formation wrote (last_bb_at, last_sb_at, last_button_at, hands_since_bb, hands_since_sb), recomputed from each slot's own dealt hands excluding the voided one, in `fn_lightning_instance_releases_its_reservations` (migration 20261024231549, md5-guarded); so the voided hand's big blind is not skipped in the rotation and a newcomer stays a newcomer ("NEW PLAYERS SHOULD ALWAYS BE BB FIRST", Dan 2026-10-24). No horse distinction (CLAUDE.md 10.5).
