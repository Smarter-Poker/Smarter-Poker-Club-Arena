# A Lightning Join Never Queues

Dan: "REMOVE THE ABILITY TO EVEN JOIN A WAITING LIST IN A LIGHTNING GAME, PLAYER BUYS IN AND GETS DEALT INTO A NEW TABLE ASAP, NO WAITING".

**Cause, read from production (07:40 UTC).** 13 of 17 Lightning games had every physical table at 6/6 with no unreserved chair. `fn_cash_game_join` then wrote a `cash_game_waitlist` row and answered `waitlisted`. For Lightning nothing ever answers that row: `fn_cash_cluster_tick`, the only caller that opens a feeder, stands down for `cluster_mode = 'lightning'`, and `fn_cash_cluster_lightning_drive` only drives the mode. Players were queued tonight on PLO5 1.00/2.00 (6), PLO4 1.00/2.00 (3) and PLO5 0.50/1.00 (2).

**Fix.** `20261024073506_lightning_join_opens_a_table_instead_of_queueing.sql`: in a Lightning game with no open chair, the join opens one more live table through `fn_cash_cluster_open_table` (same ruleset; born halted as a Lightning anchor) and holds the caller's chair exactly as the existing seat branch does. The game row is held for the whole join, so concurrent joiners cannot open two tables; the next joiner is seated on the new one. Classic and must-move games keep their waiting list.

**Proof.** A single rolled-back `DO` probe on production compiled the new body into `pg_temp` and joined PLO5 1.00/2.00 twice: before, 0 tables with an open chair; the first join opened one live feeder (status waiting, `dealing_halted_reason = lightning`, buy-in 200-400) and held a chair on it; the second join was seated on that same table. One `lightning_table_opened_for_join` event. Nothing committed.

The client side of the same request (no Join Waitlist, Full or Waiting count in Lightning lobby surfaces) is PR #7894.
