# Diamond Phase 8: The Diamond Guards Are Watched

Status: Phase 8 In Progress. No Checklist Line Is Claimed By This Work. Diamond Tournaments Remain Refused At Every Door.

## The Guard The Audit Asked For Already Exists

The last item in the Phase 8 audit's order of work is the stack-to-wallet guard, mirroring the chip one that was added after 46.4 million chips were minted into horse wallets because the engine called `atomic_table_cashout` for horse seats on tournament-attached tables.

Every Diamond money path was checked against that failure, and every one of them is already guarded on both axes. `fn_poker_diamond_cashout` and `fn_poker_diamond_settle_cash_hand` refuse a table with a tournament attached and refuse custody whose purpose is not a cash seat. `fn_poker_diamond_release` refuses an active tournament entry mid-play. `fn_poker_diamond_buyin` and `fn_poker_diamond_top_up` sit behind `cash_games_enabled`, and `fn_poker_diamond_reserve` sits behind the `tournaments_enabled` switch that piece three installed. A Diamond tournament stack cannot reach a wallet through any of them. That work is not repeated here, and this changelog does not pretend it was needed.

## What Was Missing Was Anyone Watching

`fn_ca_guard_watchlist` names the functions whose definitions the estate hashes every hour and compares against a stored baseline, so that an alarm cannot be quietly disarmed. It named 28 functions, and not one of them was a Diamond function. Every guard above could have been redefined away, by a hand edit on the box or an unreviewed replace, and nothing anywhere would have noticed. That is the same shape of silence the 28 exist to break.

The four arithmetic rules Phase 8 installed had the same gap. `fn_ca_unit_floor_cents`, `fn_ca_tournament_unit_cents`, `fn_ca_prize_ladder` and `fn_ca_recovery_fee_cents` are pinned by laws that read migration source and by vectors compared against generated output, and neither of those sees a live redefinition in production. Redefine the floor to stop flooring and the prize ladder, the recovery fee, the chip chop and both bounty splits all silently stop snapping, with every test still green.

## What Changed

The list is 41 names. The eight Diamond money doors are on it: reserve, release, cashout, settle_cash_hand, buyin, top_up, seat_keeps_custody and plain_cash_table. The four unit rules are on it. And the list is on its own list, because a watchlist nobody watches can be shortened as easily as the guards it names.

The thirteen are baselined through the estate's own declaration door, `fn_ca_declare_guard_redefinition`, in the same transaction that widens the list and against this migration's name. Adding a name to the list raises nothing on its own, since the watcher only reports a hash that moves from an existing baseline, but the baselines are seeded anyway so the first scheduled run after this has nothing to say rather than thirteen things, and the drift board shows who baselined them and why.

## What The Migration Proves Before It Applies

It checks every name exists in `public`, once, before it widens anything, because a watched name that does not exist makes the watcher raise a warning every hour. It refuses to overwrite a baseline that somebody else already set. It checks the 28 are all still there, that the count is exactly 41, that each of the thirteen sits exactly on its baseline with its text kept for a later diff, and that each carries this migration's name. It asserts only its own thirteen quiet: one of the original 28 is currently sitting away from its baseline with an open notice, and that is somebody else's to close, not something this migration should assert away or be blocked by. And it checks the list is still not executable by a caller with no account or an ordinary signed-in one, because the prize ladder migration recreated a function and found it granted to anon by default.

The whole migration was rehearsed against production inside a transaction that ends in a deliberate error, so it could not commit. Every assertion passed: 41 names, 41 baselines, 13 declared by this migration, 13 history rows kept, grants unchanged. Production was checked afterwards and carried none of it.

## The Law That Had To Grow With The List

The declared-guard law says a migration that redefines a watched guard must declare it in the same transaction, and it reads the list from the newest migration that defines it so a new guard is covered automatically. Widening the list for the first time showed what that shape had not accounted for: eleven earlier migrations had redefined these functions before anything watched them, and none of them could have declared a change to a list they were not on. They would all have become offenders retroactively.

The law now knows that a guard is watched from the migration that first named it. Migrations before that point are history for that guard, exactly as migrations before the declaration law are history for the original 28. A migration owes a declaration only for a guard that was already watched when it ran. This is a widening of the law's memory, not a loosening: the next migration that redefines a Diamond door without declaring it will be caught.

## Where Phase 8 Stands

The five pieces the audit ordered are shipped: one prize ladder, one recovery fee, the tournament door with a switch, the chop and the bounties, and the guards watched. The estate state is unchanged by this piece: both switches closed, custody empty, no Diamond tournament exists.

What Phase 8 still does not have, and this changelog does not claim: the first `tournament_entry` custody row, which is a buy-in against a real wallet; the tournament read joining clubs so a quote and the mystery pool cap can learn their unit rather than defaulting to a cent; and the restart-recovery and finishing-position evidence the checklist names. Those belong with the work that opens the Diamond tournament door.

## Applied

Migration `20260912122636_the_diamond_guards_are_watched.sql`, applied once. Never reapply. It adds no function, no table and no column; it replaces the body of one list and records thirteen baselines.
