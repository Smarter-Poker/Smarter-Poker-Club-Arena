# Horses rebuy 75% of eligible MTT busts, and bounty rebuys stop colliding

**Dan, 2026-10-24:** "HORSES NEED TO BE REBUYING 75% OF THE TIME IN ANY MTT'S IF
THE ARE ELGIBLE TO. MAKE SURE THAT THIS DOESN'T HAPPEN EVER AGAIN WHERE THERE IS
ONLY 9 REBUYS, THIS LOOKS FAKE" - on 3K GTD Friday Fight Night PKO (827a1b52):
276 entries, 9 rebuys.

## What was measured

- 36 horse busts fell inside the rebuy window. The horse input device chose
  YES on 16 (45% rule from 2026-10-22). Only 9 purchases committed.
- The other 7 were refused by `process_tournament_rebuy` on every retry for the
  whole 30 second decision window, then eliminated. Postgres:
  `finishing place 241 ... is already held by 1c7fc49a - refusing to stamp
  294fd624`, raised by `trg_tournament_place_collision` under
  `fn_claim_bounty_legacy_candidate_20260907` <- `fn_ca_settle_bounty_rebuy_generation_v1`.
- Platform-wide, 24 hours to 07:30 UTC: 5,846 rebuys refused by that trigger,
  more than every other refusal combined. Horse rebuy share per three-hour
  bucket since the 45% rule went live: ~40-50% on non-bounty events, 2-7% on
  bounty/PKO/mystery events.

## Root causes and fixes

1. **The rate.** `HORSE_TOURNAMENT_REBUY_SHARE` is now 0.75
   (`server/src/tournament/horseTournamentRebuyChoice.ts`), pinned by its law
   test. Engine change: activates at the daily 04:00 Chicago engine release.
2. **The collision.** A bounty rebuy stamps a temporary field position on the
   entry while it settles the old head. It used the raw `playing` count, which
   is often the place the newest real elimination already holds. Migration
   `20261024072516_a_bounty_rebuy_never_borrows_a_held_finishing_place` steps
   that temporary position down to a free place (fallback: above the highest
   held place). The prize is still 0 and the money core still clears it; the
   bounty obligation keeps recording it as before (that column already allowed
   repeats). Pinned by
   `tests/a-bounty-rebuy-never-borrows-a-held-finishing-place.law.test.ts`.

## Damage already done

None to settle. Each refused purchase rolled back completely (no debit, no
seat, no bounty movement), and each affected horse was eliminated through the
normal door with its normal place and payout. The rebuys that did not happen
are not owed to anyone; the fix is that they happen from now on.

## Still open (smaller, separate causes in the same 24 hours)

- `F06_SOURCE_EXCLUDED` from `fn_ca_assign_tournament_player_seat_locked` during
  a rebuy seat assignment: 294.
- `Atomic bounty rebuy claim refused` on mystery-bounty `mystery_pre` claims: 67.
