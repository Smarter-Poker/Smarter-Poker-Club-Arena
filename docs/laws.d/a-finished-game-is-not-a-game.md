# tests/a-finished-game-is-not-a-game.law.test.ts

A seat at a tournament that is COMPLETING, COMPLETED or CANCELLED is not a
game a player is committed to, and fn_concurrent_game_load - the one function
every four-table-cap reader uses - must exclude it, in the migration that
introduced the rule and in whatever migration defines the function last. A
satellite winner at the cap is delivered the frozen ticket value as cash
(four_table_cap), decided under the cap triggers' lock before any write, so a
refused chair can never again become a settlement that cannot complete. And
the wallet a tournament entry is debited from is the wallet the entry is
stamped with: atomic_deduct_wallet_and_log resolves through
fn_tournament_club_for_user exactly as the stamp trigger does, refuses out
loud when no wallet in the union resolves, and the one-time correction that
shipped with it re-stamped only in-flight entries to the wallet the ledger
proves was charged.
