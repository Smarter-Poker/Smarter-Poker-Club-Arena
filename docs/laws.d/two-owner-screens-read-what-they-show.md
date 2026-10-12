# tests/two-owner-screens-read-what-they-show.law.test.ts

The Club Data game page ranks tournaments from a covering key index (idx_tournaments_game_page_keys, built CONCURRENTLY) and reads a name only for a name search, with fee, winnings and players read by key for the visible rows only; the Cashier Statements totals read the receipt-mirrored movement set first into an array ($19) so the two covering-index scans may run in parallel. Both bodies pinned by md5 over production's live text (migration 20261007041535).
