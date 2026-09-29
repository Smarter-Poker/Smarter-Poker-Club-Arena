# Diamond Phase 10, Line 1: A Diamond Hand Keeps Its Own Statistics

Status: applied. A player's statistics are read in one asset at a time, and a chip figure and a Diamond figure are never summed. No Diamond hand has been dealt yet (the switches are closed); this makes sure the first one lands in its own figures.

## What Was Wrong

The per-hand stat table (`ca_hand_player_stat`) and the player-to-hand index (`ca_hand_player_idx`) had no asset column, and all seven stats readers took only the player. The first Diamond hand would have added its profit, winnings and rake to the player's chip figures at write time, so no later repair could separate them. The fix was drafted on 2026-09-20 (branch `agent/cw-diamond-stats/needs-apply/...`, never pushed) with its client half merged in #4955 behind `STATS_RPCS_ARE_SCOPED = false`.

The draft could not be applied as written: its pin on the post-commit projection moved on 2026-09-22 (`a_members_profit_is_each_hands_own_net`); it stamped the asset in the projection only, while four other functions write the same tables and two of them (the forward roll and the index refresh, run by World Hub's club-stats cron) can reach a new hand first; and it built indexes and validated checks under an exclusive lock on a table every hand writes (a plain scan of `ca_hand_player_idx`, 17.9 million rows, took 9.5 s).

## The Database

Migration `a_diamond_hand_keeps_its_own_statistics` (applied as `20260920065728`, the version reserved for the draft; stored text byte-identical to the repo file, md5 `b0ed25699164f1d4ede8ee750bfe8617`):

- Both tables gain `asset text NOT NULL DEFAULT 'chips'` (a catalogue default, no rewrite) with a check constraint added `NOT VALID` (every existing row holds the default). The preflight proves no hand has ever been dealt at a Diamond table or in a Diamond tournament, so the default is exact.
- `fn_ca_hand_player_row_takes_its_hands_asset`, a BEFORE INSERT OR UPDATE OF asset, hand_id trigger on both tables, sets the asset from the hand: its table's club, else its tournament's club. Every writer is covered without being edited, and a writer that names the wrong asset is overruled.
- `ca_player_stats_overview_v2`, `ca_player_stats_full`, `ca_player_stats_pulse`, `ca_player_ev_curve`, `ca_player_hand_grid`, `ca_player_class_hands`, `ca_player_rake_stats` and `ca_player_nemesis` take `p_asset` as their last argument (default `chips`), refuse any other value, and read that asset only: the stat and index rows by the new column; the settlement facts, the head-to-head transfers and the tournament block by their club's asset (a row with no club is a chip row). Each edit is an asserted substitution with the live md5 pinned and the reverse proved; each old signature is dropped first and the grants restated as they were. The stats page payload names its asset in `scope.asset`.
- The forward roll and the prune keep the newest rows per player per asset, so a player's Diamond history is not eaten by their chip hands.

No index was built. The readers filter rows they already fetch, except the lifetime count and the pulse, which read the index table: the heaviest human account holds 1,714 index rows (milliseconds); the heaviest horse holds 40,551 (2.7 s filtered against 12.6 ms index-only), and nobody opens a horse's stats page. An index on `(user_id, asset, created_at DESC)` is the next step when human volume makes it matter; it has to be built `CONCURRENTLY`, outside the migration runner.

## The Client

`STATS_RPCS_ARE_SCOPED` is now true: every stats read sends `p_asset`, and a Diamond-scoped read is answered instead of refused. The one-hand rake-share read sends no scope, because its RPC takes none. Every surface in the app still asks for chips; no Diamond statistics surface exists yet.

## The Rehearsal

One rolled-back transaction before the apply: one real player's chip figures read first; one Diamond hand (a copy of that player's newest chip showdown, at a Diamond table) dealt through the real post-commit projection, whose 8 index and 8 stat rows were all Diamond; writers naming the wrong asset overruled both ways and an unknown asset refused; then, as that player, the stats page, pulse, EV curve, grid, grid cell, rake and nemesis unchanged in chips and returning exactly the one Diamond hand in Diamonds; an unknown asset, another player's figures and the service-only payload refused; the Diamond supply identity unmoved.

Law: a-diamond-hand-keeps-its-own-statistics. The client law `chip-and-diamond-figures-never-sum` now pins the scoped state.
