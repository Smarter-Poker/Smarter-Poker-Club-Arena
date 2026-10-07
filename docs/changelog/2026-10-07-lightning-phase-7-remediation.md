# Lightning Phase 7 Remediation: The Reversion Review Findings Are Closed

Migration: `supabase/migrations/20261007222717_lightning_phase_7_remediation_the_reversion_review_findings_.sql`

Review of Lightning Phase 7 (20261001222856, the LIGHTNING to MUST-MOVE
reversion and the tick-driven conversions) found five defects. Each is fixed
at its root in one migration, every change an asserted substitution into the
body production carries, guarded so the file is re-appliable, with no grant
change and no `is_horse` anywhere (Law 10.5).

## Finding 1 (P1): The Unfreeze Orphaned Its Conversion

`fn_cash_cluster_unfreeze` returned a Cluster frozen out of `pending_off` to
`must_move` while leaving its pending `cash_cluster_conversion` row open and
the engine halt acknowledgements set. The one-open-per-cluster unique index
then refused every later `fn_cash_cluster_begin_pending_on` as an exception,
which `fn_cash_cluster_lightning_drive` recorded as `lightning_drive_error` on
every tick pass (about 17k events a day), and
`fn_cash_cluster_reap_stuck_conversions` skipped the orphan for ever as
`not_a_pending_on_lightning_conversion`.

Fixed three ways:

- The unfreeze now aborts any pending conversion of the Cluster (status
  `aborted`, abort reason `cluster_unfrozen`, `closed_at` set), reports
  `conversions_aborted`, and clears `dealing_halt_observed_at` exactly as
  `fn_cash_cluster_commit_must_move` does, so the next PENDING_ON waits for a
  fresh observation of its own halt.
- The reaper aborts any pending conversion whose Cluster's mode is not that
  conversion's own pending mode, with abort reason `orphaned_by_<mode>` and a
  `lightning_conversion_orphan_reaped` event, instead of skipping it.
- `fn_cash_cluster_begin_pending_on` and `fn_cash_cluster_begin_pending_off`
  answer a structured refusal, `conversion_already_open`, naming the blocking
  conversion, instead of dying on the unique index.

## Finding 2 (P2): The No-Money Digest Could False-Alarm and Grew Unboundedly

`fn_cash_cluster_commit_must_move` took its two no-money-moved md5 digests
unlocked at READ COMMITTED over every historical row, so ordinary concurrent
seat or session traffic committing between them (an engine `is_sitting_out`
update, `fn_request_seat_departure`, `fn_cash_session_evaluate`) could trip
`LIGHTNING_REVERSION_MOVED_MONEY` as a false alarm, and the digest's cost grew
with the Cluster's whole history. The live rows are now taken FOR SHARE first,
in the estate's order (the Cluster row is already held FOR UPDATE, then the
seats in seat-id order as formation takes its anchors, then the open cash
sessions, then the blind ledger), and both digests cover exactly the live
rows: seats whose `left_at` is null, sessions whose `closed_at` is null, and
the Cluster's blind ledger.

## Finding 3 (P2): A Voided Formation Kept Its Blind Credit, and the Drain Flapped

`fn_lightning_form_hand` counts bb, sb and the positions into
`lightning_blind_ledger` at formation. No abandon path reversed them, and
`fn_cash_cluster_begin_pending_off` voids every reserved formation, so players
were credited blinds they never posted and `fn_lightning_blind_order` then
skipped them for a blind they never paid.

Fixed at the one door every abandon path crosses:
`fn_lightning_instance_releases_its_reservations`, the AFTER UPDATE trigger on
`lightning_instance`, reverses exactly the increments formation made for the
hand's participants when an instance is abandoned before `begin_dealing` ever
ran (`started_at` null), floored at zero, exactly once per instance.
Formation touches no debt field, so none needs restoring; a hand that dealt
keeps its counts because its blinds were posted at the felt.

And the population trigger now dwells: the OFF condition must be seen on two
consecutive sightings, the first recorded durably in the new nullable column
`cash_games.lightning_off_condition_since`, or stand for the configured
`pending_off_dwell_ms` (a validated `fn_lightning_config` key, default 10000,
0 disables it). A drive pass that does not see the condition clears the
sighting, so a population hovering at 12/13 voids nothing. A disabled Cluster
or game still drains at once.

## Finding 4 (P3): A Disabled Game's Reversion Lifted the Halts

`fn_cash_cluster_commit_must_move` lifted the Lightning halts even when the
game itself is disabled (`cash_games.enabled` not true). A disabled game's
member tables now stay halted for the game-close path that owns them, and the
result and the `lightning_off` event say so: `halts_kept_game_disabled`.

## Finding 5 (P3): The Drain Polls Took the Cluster Lock

`fn_cash_cluster_commit_must_move` and `fn_cash_cluster_commit_lightning` took
the Cluster row FOR UPDATE before running their cheap in-flight counts, so
every drain poll serialised against formation and the tick. Each now runs its
cheap count first, without the lock (`instances_in_flight` and
`hands_in_flight` respectively), and takes the lock only when the count is
zero. The authoritative in-lock count stays.

## Proof

`scripts/dev/test-lightning-phase7-reversion.sh` grew ten sections (17 to
26): each defect is first proven real on the Phase 7 code, then the
remediation is applied and each fix proven against the running estate with
humans and horses side by side, every earlier @live-proof re-evaluated, and
the file applied twice. `tests/lightning-phase-7-reversion.test.ts` pins the
transaction shape, the asserted substitutions, the pre-lock ordering, the
ledger reversal's floors and Law 10.5. The schema manifest fragment
`scripts/ci/schema-manifest.d/lightning-phase7-remediation.json` promises the
one new column. Not applied to production by this change.
