# Tournament creation option correction verification

The displayed Free Buy and add-ons-from-start choices lost their enabled values in the client helper and in the governed creator INSERT. The accepted zero-entry MTT fixture reproduced both persisted flags as false while preserving paid rebuy and add-on prices. The correction carries both explicit flags through the existing client/server helpers and persists them through an exact-source-gated creator patch. Initial entry and repeat-purchase price expressions are unchanged.

The initial static matrix contained 22 unmatched RPC roots. Review against the reconstructed current governed creator resolved 20 through aliases or derived values; freeBuy and addOnFromStart were the two confirmed omissions. The matrix records source mapping and existing captured test outcomes. It is not a claim that every displayed permutation received an independent database test.

## Final checks

- Native PostgreSQL: 14 option assertions passed, alongside 15 reused base creation/permission checks. The candidate applied twice in one transaction. Actual authenticated RPC calls and owner readback proved both flags, zero initial entry/fee, and paid rebuy/add-on prices. Zero-price SNG and Spin exclusions and six exact-code refusals passed. Full business/catalog rollback and input source stability matched exactly.
- Focused tests: 3 files, 40 tests passed against the actual client mapper, RPC builder, free-buy helpers, and existing eligibility law. Source hashes stayed unchanged during the run.
- Client TypeScript passed. The final server TypeScript run no longer reports the corrected helper; it reports one independently changing maintenance test error at maintenanceThawV3.test.ts:39. The coordinating agent owns the combined server check after that change settles.
- Owned source diff whitespace checks passed. The default-discovered capture test is absent; the explicit development generator preserves its original template bytes and SHA-256 61f022e9ced004b5e67a2aaf22d394b6bc8285a69afe12654c5114c7c7cadba4.

The failed late rehearsal was a probe setup error: its business snapshot preceded temporary policy-case table DDL, which appended public.ca_ddl_events. Moving the snapshot after fixture DDL made the full equality check pass. No relation was excluded, no production grant was expanded, and no guard was disabled.

## Eligibility and readback

The candidate uses the unchanged canonical fn_is_free_buy_event predicate against the exact monetary, format, and variant expressions the creator persists. Enabled flags cannot make paid, SNG, or Spin requests eligible. Malformed booleans are refused. No prior rows or price expressions are rewritten. The client and server row helpers preserve the same eligibility rule and paid repeat-purchase terms.

Persisted consumers were inspected locally: FreeBuy.auditFreeBuyRow, TournamentManagerBase lifecycle and add-on activation paths, ScheduledTournamentService, TournamentRecurringService, HorseOrchestrator, and the published managed contracts. The existing snake-case columns already form their readback contract; helper serializers now emit those fields. Native row readback verifies the storage boundary. Browser interactions are outside this correction evidence.

## Frozen candidate and evidence

- Candidate: scripts/ci/probes/tournament-create-options-persist-flags-candidate.sql
- Candidate SHA-256: e16b3a057460833cd74c7a2da612df8b2c5269e156a7cc7b8116679d7fb6b24a
- Governed creator body MD5: 855086582b43d915ed6bc4c124a34696 -> ef2671b3cb67a8c710a7fbe3f0431ef6
- Unchanged wrapper MD5: 16305fb3739f13e64af6a1e8eb3bf165
- Unchanged eligibility MD5: e83794453846edb7d457e77603e5b141
- Authoritative final native evidence: 2026-09-11-tournament-create-options-policy-final.json
- Final focused/type verification: 2026-09-11-tournament-create-options-final-source-verification.json
- Earlier before/after, diagnostic, and initial candidate files are historical evidence; initial-candidate.sql is superseded and must not be applied.

This subtask performed disposable rollback rehearsals only. The coordinating agent owns migration registration, any production application, combined checks, Git publication, and the overall Phase 3 acceptance decision.
