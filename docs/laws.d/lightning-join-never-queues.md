# tests/lightning/lightning-join-never-queues.law.test.ts

Dan 2026-10-24: a Lightning game has no waiting list. When every table of a Lightning game is full, `fn_cash_game_join` opens one more live table for the game through `fn_cash_cluster_open_table` and holds the caller a chair on it, instead of writing a `cash_game_waitlist` row that nothing for Lightning ever answers. The law pins the md5-guarded replacement, the Lightning-only branch, the held chair and the absence of any waitlist write or horse distinction in it.
