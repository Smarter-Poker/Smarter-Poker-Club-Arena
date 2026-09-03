# 2026-08-30 — Satellite hardening, phases 1-3

Agent: Claude (Cowork, local). Continuation of the satellite audit
(2026-08-30-satellite-audit-late-reg-and-double-qualification.md). Dan
delegated the open decisions; these are the calls and the builds.

## Phase 1 — history reconciled, no clawbacks

Every completed satellite's overlay (4,132.50 chips over 16 events: deliberate
guarantee shortfalls + the pre-#1935 cash bug + the audit back-pays) became
acknowledged-baseline DATA in tournament_conservation_baseline, following the
estate's pre-funding-minting precedent. The chips sit in player wallets and
the promises were the platform's own; clawing back was rejected.

## Phase 2 — guarantees sized to the field, and a floor rather than a cap

Templates promised seats their ~24-runner fields never fund ($25: 5 seats =
460 overlay per event, daily). Future spawns: $25 -> 3 seats, $10 -> 1, $5
stays 1, lobby copy updated. Open events keep their advertised numbers.

planSatelliteAwards now treats the configured guarantee as a FLOOR:
max(guarantee, floor(pool / ticket)). A field that out-funds its guarantee
gets the extra seats instead of one finisher getting a pile of cash. Pinned
in satelliteAwardPlan.test.ts; two tests that unknowingly pinned the cap were
updated in the same commit, per the red-test law.

## Phase 3 — conservation watchdog

fn_satellite_conservation_audit (DB, service-role only) + FeeReconciler.
auditSatelliteConservation (engine, hourly alongside the BBJ/rake drift
audits): any completed satellite with an unpaid winner or disbursement beyond
max(pool, awardable seats) files a critical financial alert. Asserted clean
over the audited week at apply time — its job is catching NEW damage.

## Also in this window (live incident)

A paid rebuy in the restarted Sunday $200 was overrun by the bust sweep 506ms
later (rebuy debit 21:13:57.405, elimination 21:13:57.911): player charged
200, chips granted, then eliminated and unseated. Row restored by migration
restore_rebuy_eliminated_player_kingfish; the race fix and Dan's non-pausing
rebuy directive are the next phase.
