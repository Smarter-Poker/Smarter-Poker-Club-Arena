# Restore MTT lifecycle corrections on the provider baseline

This independently compatible delivery restores the existing R20-R45 MTT
application work after the September13 source restoration. It preserves the
current client layout, lease/deadline protections, complete running-tournament
enumeration, cash occupancy handling and removal of external error telemetry.
The existing protected GitHub/Hetzner release routes remain unchanged.

The original registering-tournament walk now retains up to four actual funding
operations across passes instead of making every ready tournament wait for
unrelated funding. The same ownership covers awarded-ticket entry before and
during late registration. An event cannot launch while its own funding is
unresolved, and shutdown joins the complete owned continuations. No discovery
loop, timer or repair service is added. Running-ticket timestamps remain until
the existing45-second interval expires; a direct regression reproduced the
original early repeat and passes with the corrected prune condition.

Recovered behavior includes exact-cent bounty creation, engine-owned blind and
starting-stack profiles, atomic mystery options, maintenance-safe blind clocks,
current-state resume, terminal clock retirement, accurate entry-window display,
selected paid depth and capacity-independent provisional payout previews.
Existing PKO causal/terminal and committed-payout migration sources and native
regressions are restored. Ten SQL files were already installed: their bytes and
26 current function bodies were reconciled on September17; no migration was
reapplied. The truncated terminal-coverage source filename now matches its
installed migration name without changing SQL bytes.

## Verification before submission

- 532 affected engine cases across19 files passed; both TypeScript checks passed.
- 350 affected client cases across20 files passed across the initial run and the
  final18-case card rerun. The only initial client failure expected donor markup;
  its exact visible-label assertion now uses the restored layout and still
  requires the late-entry label to disappear after finalization.
- 21 direct-admission/shutdown cases passed, including fulfilled/rejected funding
  continuations. These are controlled component tests, not production journeys.
- Real isolated PostgreSQL17 PKO causal claims and terminal-coverage probes,
  seven cluster cleanup controls,57 committed-payout groups and44 creation-depth
  groups passed. Their captured schemas and explicit stand-ins remain documented
  in the existing fixture READMEs; this is not full production financial proof.
- The four preserved native commands are added to the existing hosted accounting
  job. Existing change classification includes the cleanup test;25 classifier/
  workflow checks passed. No new job, publisher or local release path is added.

Last successful equivalent hosted baseline: required CI35159037199,
headb8cc58274cc184ae3baba2e0a2a33d93122ceb16, all client/engine shards,
accounting, compilation and production build passed before this composition.
Final protected checks, merge, publication and connected live behavior remain
separate requirements.

## Work still assigned

R46 unlimited MTT/satellite entry is preserved at original PR4701 donor
cc633751429bbbd5b1937721c08bab8b32c30555 and is not activated by this delivery.
It still requires coupled database/application transition qualification:
nullable capacity, legacy satellite interpretation, restart identity and the
atomic scheduled-satellite writer. The old boot-only contract/stopped-DDL plan
has no qualified installation seam and conflicts with the existing break DDL
guard. Do not enable its dependent creators or client until the actual contract
is qualified and installed. Genuine SNG/Spin capacity and physical seats remain
separate from the owner's unlimited MTT requirement.

Stable live MTT readiness, funded format journeys, blind/break progress,
ticket/prize/bounty reconciliation and the documented historical paid-rank
discrepancy remain task acceptance requirements. This release is not a claim
that the entire MTT assignment is complete.
