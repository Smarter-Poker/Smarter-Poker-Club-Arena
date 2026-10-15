# tests/club-data-is-live-and-counts-the-felt.law.test.ts

Club Data is real time (Dan 2026-10-14): cash rake and cash buy-ins/cash-outs are written to club_table_daily by the rake and wallet insert triggers in the same transaction as the money, the hourly job never rewrites the live UTC day, and ca_club_data_snapshot adds every seated club player's live stack to winnings so chips on the felt never read as a loss; the everyday screen at clubs/:clubId/data re-reads every 15 seconds and never paints zeros for a failed read.
