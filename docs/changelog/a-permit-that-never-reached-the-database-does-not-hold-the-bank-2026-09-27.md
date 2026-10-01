# 2026-09-27: a permit that never reached the database does not hold the bank

Tournament 72e595f4 ("$100 Freeroll - 6:00 PM") on engine cfe8a739: tables 7e681bb6, a7f144bb, a4583f4a and df913df7 committed their last hands at 23:19:33-37Z, during the add-on window, while Supabase calls were timing out. Their next `fn_f06_begin_hand` call lost its reply, so each engine's permit went to phase `unknown` (`f06_permit_unproven`) and every later deal attempt threw `f06_prior_hand_unresolved`. The zombie reaper stopped the engines at 23:22:37Z, and the replacement was refused because the original's F06 preparation was still unresolved. The database holds no permit row above any of the four last hands: the begin never committed.

The only way to resolve that preparation is the stopped-custody park with the engine's attestation (20260927153827). But the park looked the attested permit up by id, found no row, and refused `unstarted_permit_not_this_engines` (engine log 23:53:02Z, all four). /health reported `f06_preparation_stuck` 4 and `stopped_bank_custody_unwritten` 4 with `readyForRestart` false, and the 23:55Z break did not cut over: at 00:05Z the lease was still instance 1-730b8fe1. The engine certificate for cfe8a739 (run 36359297209) failed on `stalledTableCount` 4.

Migration `20260928001128_a_permit_that_never_reached_the_database_does_not_hold_the_b.sql` makes three changes:

- It adds `smarter_private.f06_absent_permit_releases`. The table is append-only, has RLS on and grants nothing.
- It changes `fn_park_stopped_time_bank_custody`. When no row carries the attested permit id, the park first takes the tournament lane that `fn_f06_begin_hand` commits under, before the retired-origin try-lock, and then reads again. If the row has appeared, the existing path runs unchanged. If it is still absent, the park releases it only with the caller's generation and only when there is no durable witness of a hand at the attested number: no permit of any id, dispatch, atomic commit, history, snapshot, private state or hole cards. The release is recorded once: a replay of the same shape gets the same answer, and any other shape is refused.
- It makes `fn_f06_begin_hand` refuse `permit_released_absent` for a recorded permit, so a late begin can never start that hand.

The engine is unchanged. It already attests a permit in phase `unknown` and clears it only when the database names it back.

Before writing the migration, both bodies were run against production as pg_temp copies inside rolled-back transactions (table 7e681bb6, custody 16124103):

- The old park refused.
- The new park released, and a replay got the same release.
- Another hand number was refused.
- A number that carries a permit and hand_history was refused with `absent_permit_start_witness`, and nothing was recorded.
- A late begin answered `permit_released_absent`.

Law test: `tests/a-permit-that-never-reached-the-database-does-not-hold-the-bank.law.test.ts` (8 tests; 6 fail on the tree without the migration).
