# Handoff — current state pointer

The full continuation handoff for the **horse bankroll layer** and the
**2026-08-31 cash-floor outage** lives at:

> [`.agent/handoffs/2026-08-31-horse-bankroll-and-cash-floor-incident.md`](../.agent/handoffs/2026-08-31-horse-bankroll-and-cash-floor-incident.md)

It is kept there because `.agent/handoffs/` is this repo's handoff convention —
see the three other handoffs merged the same day (#2169, #2170, #2171). This
file exists only so anyone looking for `docs/HANDOFF_CURRENT_STATE.md` finds it.

## Thirty-second version

- **Floor status at handoff:** healthy. 47 horse cash seats / 23 tables, 308
  cash hands in 10 minutes, **0 unaccounted seat exits**.
- **What is live in `main`:** the bankroll core (`HorseBankroll.ts`), the seating
  gate with the club-derivation fix and fail-open behaviour, the rotator's reload
  cap and session exit, and the incident fix (#2151) with its 5 pins.
- **What is reverted and waiting to be re-landed:** tournament bankroll gate,
  freeroll routing, rebuy decision, aggregate exposure, telemetry, stake descent.
  Branches `feat/bankroll-close-the-loop` and `feat/stake-descent-ladder`;
  merged commits `6eae5e2b90` (#2118) and `ef1f656003` (#2128).
- **Start here:** section 22 of the handoff — a five-step, read-only checklist.
- **Do not** re-introduce `for (const clubId of this.clubIds)` in the bankroll
  loader, and **do not** change `if (roll === undefined)` back to `return false`.
  Those two lines emptied the cash floor for 55 minutes.

## Known repo-vs-production drift (fix first)

`supabase/migrations/20260831_retire_atomic_seat_horse_the_dead_minting_path.sql`
was **applied to production** (migration `20260831104745`) but its file was
reverted out of `main` as part of #2143. Until the file is restored, replaying
migrations from scratch would re-create a function that mints chips from the
frozen `public.wallets` pool. See Phase 1 of the handoff.
