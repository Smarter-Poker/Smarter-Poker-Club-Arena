# Current and legacy tournament terminal integration

This is a locally qualified integration package for the coordinating release owner. It has not been applied to production and is not a release certificate.

## Prepared change

`compose-current-legacy-terminal-activation.py --check` reproduces and authenticates the generated one-transaction activation. It composes D9 sealed legacy standings and deferred certification with the current manager target, finish claim, seat consumption and strict money authority. Original Phase 3 source files remain unchanged. The cash writer and verifier retain their D9 identities; D12 retains its canonical finish claim. Previously paid satellite receipts retain their recorded payouts.

The authorization snapshot now binds each seat to its table, chair, joined time and occupancy UUID. A reused seat row cannot satisfy the previous occupancy's proof. Both current and legacy paths verify the exact issued and consumed set before final certification. The activation requires the canonical occupancy column and stamping trigger, checks 33 final function contracts and 11 protected triggers, and refuses leftover capabilities.

Generated activation SHA256: `4a32036443014c9a7db77c9874d6599fbdf4ef5b5f9aa4cce3f3f406f58fe6ea`.

## Required order

1. The release owner supplies the exact D9 accepted facts, cash and satellite prerequisites from `7682f9340375909e6af81d4fb4f4665071e95784`, D12 claim/guards, current manager request and target-entry contracts, canonical seat consumer, occupancy schema, and existing v2 final-deal/versioned-consent contract. The generated gate authenticates its inputs. Latest launch recovery from main `b4ba5b737f1b3bdf882e2455c1e19e2077a2de7a` was preserved in native qualification.
2. Apply the generated combined activation once. Do not substitute the original separate Phase 3 files afterward: they would revert these composed authorities.
3. Apply the non-satellite ruling retirement (`20260911204101`), accepted final-deal tail (`20260911204238`), and accepted satellite standings (`20260911204452`). The satellite migration expects the combined core and therefore follows activation.
4. Production financial corrections, wakes, and redrives remain the coordinating owner's separate approved sequence. D8's places-only correction does not authorize a satellite or final-deal financial adjustment. Contradictory paid final-deal tails refuse rather than silently reprice. Open pre-upgrade deal consent requires a fresh proposal.

## Native verification

A fresh owned PostgreSQL 17 fixture installed the final activation atomically and all three follow-on migrations. Eight scenarios then passed 617 assertions: expanded current manager/M2 (131), actual final-deal terminal (41), five accepted-bust ordering cases (74 each), and unknown-witness refusal (75). Every scenario restored all 1,189 application tables and the complete public/private function, trigger and constraint fingerprints exactly after rollback. Source, ACL, configuration and trigger corruption were separately rejected by the catalog gates. No production success function was mocked for these scenario runs.

Sixteen legacy deferred-order and capability fault cases passed with the strengthened occupancy proof and accepted satellite core. Prior completed satellite replay remained byte-equivalent across 30 financial/application tables after the rank migration. Earlier component evidence retains ordinary E2's 17 payouts totalling 304.00/all 167 positions, ruling retirement equivalence, and the 20-case/611-assertion final-deal witness matrix. The final composed run adds real final-deal completion and verifies D9 cash source/metadata preservation; it does not claim the older isolated component receipts alone qualify this composition.

The bust-order scenes use synthetic historical eliminated entrants and accepted-hand facts. Only the original actual 100-chip registration funds the source, so these cases prove ordering, terminal conservation, delivery and rollback, not a separate three-entrant registration test. The retained base fixture has one existing member without a profile; its foreign key was restored NOT VALID while continuing to enforce new rows. No source data was removed to make qualification pass.

Client validation: 195 targeted TournamentService/TournamentDealService/final-deal tests passed; TypeScript type checking passed. The prior client build passed before the main merge; no new post-merge build is claimed.

## Evidence and reproduction

The native SQL probes are rollback-only and must be run only in an owned local fixture with the installed prerequisites. `current-legacy-manager-native.sql` contains the original manager assertions plus the additional authority/occupancy faults. `current-legacy-final-deal-native.sql` uses the installed final-deal authorities without replacing them. The companion output package contains the six generated ranking variants, full native logs, before/after fingerprints, legacy receipts and gate-drift results. Every database call in this qualification used an owned local socket.

No production SQL, payout, wake, deployment, merge, workflow dispatch, cancellation, credential change, or shared database mutation was performed.
