# Phase 2 Additive Production Adoption

Phase 2 remains incomplete. PR 3974 is the occupancy release; final retirement and deployed engine/client verification remain mandatory.

## Local Verification

Merged implementation: client 17,578 tests passed in 1,264 files; server 8,239 tests passed in 612 files, with the opt-in PostgreSQL suite run separately. Client and server TypeScript passed. Production build passed at 4ca3a4cbd with behind-main=0; the existing configured Sentry source-map upload succeeded. This build was local, not proof of Hetzner adoption.

The idle transfer timeout now joins its original operation before releasing the seat boundary. Both startup waiting and normal idle dealing use the helper. Four new ownership cases and the existing idle/read cases passed. Main's newer button rule and failure reporting were preserved through a normal merge. Eight button fixtures now provide the actual seated occupancy roster; original button assertions remain intact.

## Production Migrations

Applied through Supabase MCP to kuklfnapbkmacvwxktbh, PostgreSQL 17.6. No production DDL/DML test probes were used.

| Migration                                                      | Live Version   |
| -------------------------------------------------------------- | -------------- |
| bind_cashout_requests_to_seat_occupancy                        | 20260909172143 |
| table_close_requires_every_occupancy_cashout_to_commit         | 20260909172241 |
| admin_departure_authority_is_recorded_before_cashout           | 20260909172312 |
| one_committed_cash_game_seat_per_player                        | 20260909172350 |
| retire_cluster_duplicate_chair_cashouts_after_native_ownership | 20260909172447 |
| terminal_tables_cannot_commit_live_occupancies                 | 20260909172529 |
| retain_original_admin_departure_outcomes                       | 20260909172615 |
| bind_cash_seat_moves_to_original_occupancies                   | 20260909173145 |

Read-only verification confirmed all three native ownership/admission constraints validated, zero active seats missing required keys, canonical definition hash 8d84b96cb2e7649ee2bf7ecf1f7028c9 and planner definition hash ae91ea39aef3746371029528cb8e343d. Three organically created cashout receipts existed at verification, which proves ordinary operations reached the new canonical writer, not that all historical incidents are resolved.

## Legacy Empty Move Destination

The pre-application review found a valid older empty cash table may have a NULL derived admission key. The initial move wrapper rejected it before the native trigger could initialize it. The new real PostgreSQL fixture reproduced one failure with 144 passing tests. The wrapper now permits that uninitialized cash parent; native admission still determines whether a seat can commit, and the existing move implementation refuses a closed destination. After correction all 145 PostgreSQL tests passed, including closed-destination no-transfer and exact retained ledger conservation. The reviewed move prosrc hash is d23c0c9ad3166df5ac8bde4ed8ab08ac.

## Release State And Remaining Gates

Automatic approval initially rejected the push because origin authorization was not established. Read-only checks proved origin is the private Smarter-Poker/Smarter-Poker-Club-Arena repository, with push permission and the normal Hetzner publisher. The normal retry was allowed. A subsequent pre-push authorization parser did not recognize the second function in a combined grant declaration; individual explicit grants preserved actual permissions and passed the normal hook. No bypass or alternate publisher was used.

The branch pushed and Agent Open PR created PR 3974. The corrected legacy-destination migration, tests and delayed voluntary-outcome protection are pushed. Normal publication and deployed-version verification remain mandatory.

Final unbound cashout retirement stays staged outside migrations until compatible engine/frontend adoption is proved. The original-occupancy cleanup protection and real Chromium persistence/locking probe are complete. Remaining gates are combined acceptance, final production grant checks and exact deployed code provenance. Phase 3 has not started.

## Delayed Voluntary Outcome Follow-Up

The remaining profit-target cleanup gap is now locally corrected. cashoutVoluntaryStay snapshots the selected user, seat and occupancy before awaiting the existing bound voluntary cashout. It suppresses local reflection if the occupancy changes or engine authority is lost, preserving the retained database result without transferring its refusal clock or presence cleanup to a later stay. The existing departure selection policy is unchanged. Six behavioral cases cover delayed success, delayed refusal, already stale selection, lost engine authority, original-stay success and already-removed original-stay success. All 68 targeted continuity/departure tests passed and server TypeScript passed. This follow-up is committed and pushed as fe913481a; deployed-version checks remain pending.

## Hosted CI Follow-Up

The PostgreSQL installer now scopes APT to the runner Ubuntu sources and official PGDG source, preserving signature and hash verification. An unrelated Chrome package-index hash mismatch no longer prevents the isolated PostgreSQL suite from running. Hosted job 102581340897 passed all 145 PostgreSQL tests in 16.97 seconds on 29f048736. The full server, all four client shards, production build and CSS browser gates passed in that run. Its remaining failure was the stale schema fragment, not missing production objects.

Read-only production catalog verification found every one of the 16 missing manifest objects. Commit 93e4e9918 adds the verified fragment; the normal migration, definer-authorization and no-band-aid gates passed. The subsequent hosted TypeScript and PostgreSQL jobs passed. This is CI evidence, not final release acceptance.

The 18:09 UTC runtime observation still served engine 5dd902e9 and frontend 14107e8b6ffabba74d7134f661e244cc03efd252. Neither observation establishes adoption of PR 3974. The scheduled deployment must carry the occupancy implementation before the staged unbound RPC retirement can run.
