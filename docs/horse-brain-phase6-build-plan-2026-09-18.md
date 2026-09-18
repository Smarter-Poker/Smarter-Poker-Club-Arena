# Phase 6: four ordered completion stages

Owner assignment: September 18, 2026. Start with 6A, finish and report each stage before the next. Horse Brain only. This refines P6.1/P6.2 in [the remaining-work plan](horse-brain-phases6-15-completion-plan-2026-09-17.md) against [the first-five blueprint](horse-brain-first-five-gold-standard.md). The earlier Horse repair delivery is separately closed; its live evidence does not certify these new stages. The first five phases supply the engineering requirements, not a claim that every historical component was already perfect.

Every stage requires its actual producer, consumer, invalid-input behavior, directly triggered regression checks, protected delivery and applicable live-use evidence. Source, checks, merge, publication and live acceptance remain separate. Do not create a new publisher, refresh loop, review store or strategy authority. Existing candidate controls and automated safeguards remain intact.

## 6A (1 of 4): truthful tournament context through accepted action

Complete the context-to-receipt foundation before changing strategic depth:

- Give each successful cache publication an immutable identity: tournament, unique cache-entry identity, successful generation, complete read interval, payload digest, original completeness and issues. A failed or pending refresh retains the previous success and its identity. Eviction/recreation cannot reuse that identity. A delayed superseded read cannot replace it.
- Freeze the cache publication and nested arrays/maps at the producer. The decision-clock read remains synchronous and never initiates database work. Cache timestamps describe several independently read relations; they do not assert an atomic database transaction.
- Distinguish cache freshness/completeness from the current hand's projection. Bind table, hand, actor, dealt seats, dealer, active variant and actual hand blinds/ante. A blind-level refresh during a hand must not give the Horse next-hand stakes.
- Carry that observation through the existing worker request, versioned preflop attribution, private execution witness and retained-hand reader. Bind the maintained atlas revision and the actual observed lookup. Preserve chart bypass, unavailable/fallback and evaluated states, and distinguish reference proposal from controller-accepted action.
- Validate new metadata against the original request; refuse mismatched generation, actor/table/hand, census, blinds, age and atlas evidence. Historical v1/missing evidence remains historical, never upgraded to new proof.
- Include provenance in the full input digest, exclude only the new diagnostic field from the sampling digest, and preserve all existing strategy inputs. Provenance alone must not choose another action or RNG stream.

Acceptance: existing cache, actual-controller blind snapshot, worker, attribution/transport and retained lifecycle tests pass with the new cases; compiler and applicable source contracts pass. Retain red-before evidence for mutable/missing cache identity and mid-hand blind drift. Publish the engine through the existing route, verify the exact containing release and sealed receipt, and inspect a finite original cohort of naturally produced v2 preflop records joined to accepted actions. Record any capture or population limits. No GTO or full-population claim.

## 6B (2 of 4): explicit supported strategy domain and complete calculation coverage

- Maintain one machine-readable domain description for the actual NLH tournament preflop atlas: 2–10 dealt seats, canonical positions, eleven branches, ante modes and the existing 2–100 BB interpolation grid. Expose the current below/above-grid approximation; do not invent calibrated deep-stack cells.
- Inventory existing independent M, position, branch and interpolation assertions against that domain. Add only missing boundary/intersection cases, including sit-outs, short-handed transitions, covering stacks, next-level projection and near-boundary M hysteresis.
- Verify each complete/incomplete/stale/warming context route and named unsupported-variant fallback. NLH evidence cannot qualify Omaha or another game family.
- Pin atlas revision, domain and actual implementation in the directly invoked verification/release evidence. Reject mismatched domain or coordinates without authorizing a substitute policy.

Acceptance: explicit matrix with executed coverage and named exclusions, independent arithmetic expectations, unchanged-positive controls, actual HorseLogic/worker consumers, publication and bounded observed route evidence. Calibration beyond the current grid needs independently qualified input, not a new label on the same heuristic.

## 6C (3 of 4): independently reproducible decision qualification

- Use the original scoped decision/read frame and accepted-action identity to replay the declared Phase 6 inputs. Preserve exact actor, persona/profile, public history, field snapshot, source generation, RNG and atlas revision; current rows cannot replace historical inputs.
- Qualify deterministic calculations and lookup outputs against independent references, and distinguish a tested heuristic from certified solver/GTO data. Test complete, sparse, missing and expired input boundaries; report what cannot be reconstructed.
- Complete the declared offline evaluation protocol: baseline, fixed source/domain, independent expected results, reproducible seeds, acceptance thresholds justified by the measured baseline and explicit refusal when required reference data is unavailable.
- Measure added latency/work with the existing harness and production observation. Keep database/network work outside the action clock and preserve live activation/withdrawal ownership. An offline result never enables a live candidate by itself.

Acceptance: reproducible original-input qualification artifact, negative controls proving substituted/stale evidence fails, retained source/evaluator identities, applicable checks and publication. A strategic-strength or GTO claim requires its actual independent evidence; deterministic replay alone cannot supply it.

## 6D (4 of 4): complete the bounded live-use qualification and handoff

- Freeze the finite original selection rule before reviewing naturally accepted preflop hands. Cover observed tournament formats, branches, table sizes, ante modes and bypass/fallback states; list unobserved cells instead of substituting friendlier samples.
- Join original request/read frame, actual computation, returned reference, final controller action and completed-hand record. Distinguish rejected/expired/replaced requests, absent capture and unsupported contexts from successful use.
- Demonstrate source replacement/freshness refusal and legacy evidence handling through the owning connected tests, and verify current deployed behavior without synthetic financial transactions against active players.
- Reconcile the Phase 6 checklist and evidence against every applicable first-five blueprint requirement. Record remaining cross-phase/shared-owner dependencies precisely; do not certify Phase 7 or Phases 8–15 from this work.

Acceptance: all Phase 6 required checks and concrete defects resolved, protected revisions published, exact live identities and bounded accepted-use evidence retained, no unexplained qualification gap. Report measured coverage and limitations. Then Phase 6 is ready for the next owner-directed phase.

## Progress

6A is in implementation. 6B–6D are planned and not claimed complete. Each completion report uses: “Phase 6A (1 of 4) is complete,” the evidence and limitations, followed by “Ready to start Phase 6B (2 of 4).” Advance those letters/counts only after the corresponding acceptance gates actually pass.
