# A bust belongs to the phase its hand was played in

2026-09-11 · database (`20260911094503`, applied to production 11:32:25 UTC)
and engine (`TournamentManagerBase.maybeActivateMysteryBounty`)

## What happened

Two mystery-bounty events could not finish: Midweek Mystery `5aa7eeba` and
DSS Wednesday `9536150e`.

In `5aa7eeba`, the mystery phase activated at 2026-09-10 06:55:55 with six
players left and five chests worth 8400c.

- Eight busts played at 06:27–06:34 were not recorded until 13:57–15:45.
- The claim door checked `mystery_bounty_stage` when it recorded them, saw
  `active`, and wrote them as `mystery_chest`.
- Four of those late-recorded busts drew four of the five chests. That paid
  6200c to two knockers who were each owed a $6.00 head.
- Three true post-activation knockouts were then left pending on
  `reserve refused: inventory_exhausted`, with about 1,000 attempts each.

`9536150e` had the same fault once.

Both events were settled by ruling at 10:16 UTC. The standings were
re-sequenced into true bust order, and the unfundable obligations were retired
as owed-and-unfunded with an audit row each; no money moved. Both events then
completed, paying places in true bust order. Every underpaid player is
recorded in `financial_alerts` for house-funded make-good. Overpayments stand.

## Three defects on one money path

1. **The claim door used the wrong clock.**
   `fn_claim_bounty_legacy_candidate_20260907` decided the mode from the stage
   at record time. It already held the exact bust hand (`v_atomic`) and never
   consulted it.
2. **Pre-activation heads could never settle.** `fn_collect_bounty` refused
   every non-chest obligation while the stage was `active`. A late bust
   written correctly as `mystery_pre` would still have stayed stuck.
3. **The seed swept owed heads into the chests.**
   - `fn_mystery_bounty_seed` sealed the chest pool from
     `bounty_pool - bounty_pool_paid`. A head that was earned but not yet
     recorded went into the chests, so the pool would pay it twice.
   - It also stamped `activated_at` with `now()`, which is the start of its
     transaction and is not ordered against the hand commits it waited behind.

## The fix

- **Claim:** the mode comes from the bust hand's commit time compared with the
  sealed activation receipt.
  - Earlier than the receipt: the pre-activation mode.
  - Later: a chest.
  - No receipt: refused, as before.
  - Order cannot be proven: the player is placed and no bounty is written.
- **Collect:** a stored `mystery_pre` head can be paid while the phase is
  active.
- **Seed:**
  - It takes the tournament settlement lane first.
  - It keeps unrecorded heads out of the chests. The amount comes from
    `fn_mystery_bounty_unrecorded_head_cents`.
  - It stamps `activated_at = clock_timestamp()` after its locks.
- **Engine:** activation reads the same unrecorded-head figure before building
  the inventory. The inventory it builds is therefore the one the seed
  accepts, instead of waiting out a claim backlog. An unreadable figure is not
  treated as zero: activation waits for the next pass.

## Order with the settle migration

`20260911062048` (settle ranks by true bust time) and this migration both
change the claim door. Settle was applied first, at 11:31:54. This migration's
claim anchor was relaxed to the declaration line so it matches the settle
body as well.

Proven on PostgreSQL 17 over both bodies, the live one and the settle one:

- all 12 "after" scenarios pass;
- a re-apply is a no-op.

## Pinned by

- `scripts/dev/probe-mystery-bust-phase-pg17.sh`: 3 "before" assertions
  reproduce the defects, and 12 "after" assertions pass.
- `server/src/tournament/MysteryActivationCutoff.test.ts`:
  - unrecorded heads shrink the inventory to what the seed accepts;
  - an unreadable figure seeds nothing.

  Both tests fail on the previous engine code.
