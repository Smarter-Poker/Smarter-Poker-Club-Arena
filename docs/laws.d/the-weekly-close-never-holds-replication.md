# tests/the-weekly-close-never-holds-replication.law.test.ts

The weekly close never holds replication (2026-10-12): job 272 runs every tick on one bounded budget (statement_timeout 240 s, 3 minute scope budget, no 3600 s / 50 minute fallback) because Supabase Realtime shuts down when one writing transaction stays open past ~1.5 GB of WAL; the union P&L report proves the plan windows first and keeps a step that found a problem for one hour (never certified, never paid), and a seal or scope step that does not fit the tick is a critical alert to split it.
