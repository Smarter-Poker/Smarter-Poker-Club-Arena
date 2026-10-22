# A Signed-In Entry Moves The Ladder, And A Deadlocked Bust Payment Retries

Migration `20261022030638_a_registering_player_refreshes_the_provisional_ladder_and_a_.sql`, applied to production 2026-10-22 03:06 UTC.

## The ladder skipped every human registration

Postgres log, 02:58:35 UTC: `provisional payout ladder refresh for 62a7c3b1-... failed: Tournament contract cannot be modified after a player has registered`. The Midweek Mystery showed 25 paid places for 201 entries until an engine entry moved it.

Cause: `fn_guard_registered_tournament_contract` refuses any contract change while `auth.uid()` is set. A browser registration fires the ladder trigger inside that player's own request, so the refresh was refused for every human entry. The earlier migration taught `fn_guard_managed_game_lifecycle` the exception and missed this second guard. It now admits the same single value: before the pool is finalized, `payout_structure` may change only to `fn_ca_provisional_payout_structure(id)`. Every other field is still refused.

Damage settled: 137 registering tournaments (3,343 entries, starting 04:00 UTC Oct 22 to Oct 24) held ladders written before the trigger existed or refused since. Each was refreshed once through `fn_ca_refresh_provisional_payout_structure`; 0 remain out of step.

Verified in one self-aborting DO block on production: eight entries inserted as a signed-in player moved the Midweek Mystery ladder 26 to 27 places, equal to the derived ladder; a hand-written ladder and a name change were both still refused.

## A deadlocked bust payment was dropped

`financial_alerts` `tournament.real_time_payout_refused`, Nightly 10K (dd9114ae), 01:42:37 UTC, sqlstate 40P01. Two tables committing busts at once each waited on a standing the other was restamping; Postgres killed one payment step. Nothing was owed (no obligations, the field far from the money) and the next bust restamped every standing. The deferred wrapper now retries 40P01, 55P03 and 40001 up to four times in a fresh subtransaction with a short growing wait. The alert is resolved with that note.

Law: `tests/a-signed-in-entry-moves-the-ladder-and-a-deadlocked-payment-retries.law.test.ts`.
