# Cash And Tournament Separation

## Assignment And Checkpoint

Owner requests full separation of cash and tournament hand histories and player statistics. Audit authoritative reads, page filters, totals, charts, drilldowns, exports and opponent HUD caches; preserve asset/club scope, privacy, historical records, finances and current tournament-start hold. No engine replacement is assumed. Operation owner: this chat, branch `fix/cash-tournament-stats-01a192bb`, checkout `/Volumes/SmarterWork/agent-work/shared-capacity/cash-tournament-stats-01a192bb/ca`, base `54976b3f59`.

Acceptance: cash and tournament figures never share a monetary total or behavioral sample; filtering precedes pagination; cache identity includes game mode; drilldowns/exports retain mode; honest empty/error/stale states; retained regression tests; protected integration, applicable migration installation, client publication and live behavior proof.

Policy read: 2026-10-31T16:12:28.991Z, canonical four policies, version 2.9, manifest SHA256 `a659f31c5c1c2b0864889508079a635dd5fe2fc98decfbfc9d3f9c80dd45ec3b`. OWNER `b9478d0331314413d8e12c41210b63479cdcabc1f86ed3fdcb3251efa36e6349`; OPERATING `a8bc3c04dce3354ebdd51a89c0b7d715af3344edcc794d33f6b3ad64506961d5`; HARDENING `d5fc451ce5caf6d6b5e64597a13883e1246581678fe53c962339d0a66136993e`; INDEX `adce89c3f838f2f373cd504a00329d53906404d1dd42a647f672af6c16f95555`. Storage guide read; both SSDs and shared-capacity volume verified. Root instructions, playbook, publishing, deploy architecture read; current checkout CLAUDE differences read. No existing checkpoint for this new assignment found. GitHub configured access works; no credentials copied.

## Findings / Delivery

Investigation ongoing. No implementation or publication claimed.

## Identified Causes And Repair

- Hand archives omitted tournament identity and summed tournament stacks into asset-denominated totals. Client candidate carries identity through the common mapper, uses server mode filters before paging, preserves scope in CSV/tracker exports and prevents tournament stacks entering cash totals.
- Global and funded-club overview queries mixed cash/tournament behavioral populations before the analysis cap. Additive separated RPCs scope both headline and analysis before aggregation; tournament money stays in its own event ledger, never hand-stack P/L.
- Cash EV, hand grids/classes, rival flow and benchmark cohorts filtered by poker variant or omitted mode. Candidate fixes the original readers/producer using tournament identity and introduces explicitly cash-named benchmark cohorts so old mixed snapshots cannot be relabeled.
- Shared-player reads and client caches lacked game mode. Candidate retains existing self/shared-membership gates and adds explicit mode receipts. Old blended observation counters cannot be reconstructed and are discarded rather than attributed to a guessed mode.
- Retained lifetime totals have no mode column. Separated lifetime counts use records with known mode; unclassified historical totals are excluded explicitly, never divided by a guessed percentage.

## Qualification And Planned Delivery

Database first, client second: additive database APIs are installed before publishing callers. No engine replacement and no wallet, payout, seat, tournament-start, retention or maintenance-policy mutation.

Native PostgreSQL 17 qualification: `STATS_PG_SCRATCH_PARENT=/Volumes/SmarterWork/agent-work/shared-capacity/cs-192bb bash scripts/dev/test-stats-club-scope-postgres.sh` passed, including existing funded-club, recorded-rate, aggression, retained-coverage fixtures and the new mode fixture. New fixture reproduces the pre-fix blend; checks cash/tournament NLH separation, uncapped headline and capped sample, identity refusal, invalid mode, archive mode before LIMIT, cash heatmap/class exclusion and 1,000-cash/1,000-tournament benchmark isolation. Fixture-only scratch writes are isolated and removed by the harness. The short task-owned scratch directory avoids the macOS Unix-socket path limit.

Client candidate: TypeScript no-emit passed. 73 focused tests passed; 69 page/render tests passed; revised security/timezone/benchmark/page/profile tests passed (85 tests). These are development results, not database installation or publication proof. An obsolete broad local test attempt was stopped after subsequent candidate changes; it is not counted as qualification. Applicable exact-candidate source contracts and normal hooks remain required.

Access: CLI's environment token cannot read secret metadata; configured keyring identity works when both GH_TOKEN and GITHUB_TOKEN are unset. Required DATABASE_URL, CA_ORIGIN_HOST/KEY, SUPABASE_URL/SERVICE_ROLE_KEY and isolated probe secret names are present. No secret values read/copied. Use the same configured keyring identity for provider operations needing that scope.

Current state: database source qualified locally; no PR/merge/install/publication yet. Client source retained privately for follow-up.

Before database final validation: canonical policies fully re-read at 2026-10-31T16:24:55.232Z; version and all hashes unchanged from the receipt above. Database-only candidate restored in the owned checkout; client changes retained in this task's stash `cash-tournament-client-01a192bb` for the follow-up after installation. Final native mode+benchmark qualification passed after the benchmark producer change. New benchmark reads use `field:cash:<asset>`; no old mixed snapshot is renamed by the client.

Database submission: commit `222866db235b7395686137e6f282f8b0ce2a250e` passed its normal pre-push hook and was pushed. Review added mode-consistent notable-hand ranking and aligned incomplete lifetime coverage metadata; native regression now exercises biggest-hand ranking in both modes. Client stash exact object: `ac92c23d892fc315fa0058619eaf0d805f49346f`. This is this task's source, not another writer's stash.

Client preparation continues independently in owned worktree `/Volumes/SmarterWork/agent-work/shared-capacity/cash-tournament-stats-01a192bb/client`, branch `fix/cash-tournament-client-01a192bb`. The task-owned stash `ac92c23d892fc315fa0058619eaf0d805f49346f` was applied without dropping the retained source. Database operation remains owned here: PR #8910, with required checks inspected on its actual head. No client publication is requested before migration installation/readback.

Resumption receipt: canonical four policies re-read 2026-10-31T16:41:46.191Z, version 2.9 and all hashes unchanged above. Recovered DB PR #8910 exact head `4e006d361b20441d58afc7c2ee51c944beedb0a6`, required checks still running with no failures observed. Client worktree remains owned here, independent client preparation continues.

Client final focused qualification: TypeScript no-emit clean; 19 directly affected test files / 295 tests passed (stats owner/shared/profile/public scopes, cash/tournament caches, archive pagination, tracker refusal and replay/detail mappings). Mobile fixture evidence at 393px has no horizontal overflow. Final committed build, performance budgets, protected checks, DB installation and live publication remain pending.
