# A Lightning hand is a hand in the stats and in the collusion scan (2026-10-24)

Lightning horse reads programme, phase 8 of 9.

## What was wrong (read from production)

- 0 of 40 settled Lightning hands sampled from one hour had a `ca_hand_facts`
  row or a `ca_hand_transfers` row. 40 of 40 physical hands from the same hour had both.
- All 40 Lightning hands had a `hand_atomic_commits` receipt. Its
  `accepted_hand_facts` held only `contributions`, `returned_uncalled` and `insurance`,
  with no `stats_facts`.
- Several readers never saw a fast-fold hand:
  - `fn_ca_collusion_scan` reads only `ca_hand_transfers`.
  - `fn_lightning_session_stats` (the Lightning session recap's VPIP/PFR) reads `ca_hand_facts`.
  - So do the player statistics and the VPIP floor (`fn_cash_vpip_status`, `fn_nit_check`).
  - This applied to horses and humans alike.

## Root cause

- A physical hand puts its private per-hand facts in the hand row's
  `_accepted_post_commit_facts.stats_facts`. The builder is `writeHandFacts` in collect-only mode.
- The accepted-hand door copies them into the immutable receipt, and
  `ca_project_hand_stats_facts` writes both tables from it.
- `fn_lightning_settle_hand` rebuilds `_accepted_post_commit_facts` from its own
  contributions and drops everything else. It also strips the row `id` the facts are keyed by.

## The fix

- **Engine** (`server/src/lightning/LightningHandFacts.ts`, wired into
  `LightningHandHost.settle`):
  - Builds the same payload with the same builder: every participant dealt in,
    keyed by the Lightning hand id, at the host table and its club.
  - Built once, so every settlement retry sends the identical request.
  - It never throws. A hand whose facts cannot be built settles exactly as before.
- **Database** (held back, applied separately: `20261025000729_lightning_hands_reach_the_stats_facts_and_the_collusion_scan.sql`):
  - Adds `fn_lightning_hand_stats_facts`. It keeps the payload only when it passes
    the projector's own scope, shape and row-type checks for exactly this hand,
    host table and club. Anything else is dropped as today, because the projector
    raises on a bad payload and would hold the hand's other side effects.
  - Patches one expression of `fn_lightning_settle_hand` through the established
    preimage/anchor/postimage `md5` pattern:
    - The kept payload is passed into `_accepted_post_commit_facts`.
    - The hand row takes the Lightning hand id as its `hand_history` id, so the
      facts and the row agree.
  - No chip, stack, rake, seat or session write changes.

## Proof

- The validator was run in `pg_temp` against 27 live physical cash payloads:
  - All 27 kept.
  - All refused with a wrong hand id or a wrong table id.
  - All refused with one corrupted field type.
  - An empty row refused.
- `aLightningHandIsAHandInTheStats.law.test.ts`:
  - The scope of every fact and transfer.
  - Settlement money equals the facts' money to the cent.
  - The payload is built once across a transport retry.
  - No facts when the builder fails or there is no club.

## Live check after release

Settled Lightning hands since the release should have `ca_hand_facts` rows (one
per participant) and `ca_hand_transfers` rows, and `hand_history.id =
lightning_hand.hand_id`.
