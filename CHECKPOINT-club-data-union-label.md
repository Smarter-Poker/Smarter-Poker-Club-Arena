# Club Data verification and union attribution, 2026-10-21

Owner: this chat. Scope: verify screenshot for Deep Stack Society UTC 2026-10-21 at screen update 20:00:28; replace personal creator attribution with hosting union, never username. Fix demonstrated capped live-game count. Client-only; no engine replacement, money writes or database changes.

Owned checkout /Volumes/SmarterWork/agent-work/club-data-union-label-20261021/repo; branch codex/club-data-union-label-20261021; base a1dfb37076. No existing assigned PR/checkpoint; historical CHECKPOINT.md belongs to global chrome and is preserved.

Read canonical policies through reader emitted 2026-10-21T20:05:26Z, v2.9, manifest a659f31c5c1c2b0864889508079a635dd5fe2fc98decfbfc9d3f9c80dd45ec3b; owner b9478d0331314413d8e12c41210b63479cdcabc1f86ed3fdcb3251efa36e6349; operating a8bc3c04dce3354ebdd51a89c0b7d715af3344edcc794d33f6b3ad64506961d5; hardening d5fc451ce5caf6d6b5e64597a13883e1246581678fe53c962339d0a66136993e; index adce89c3f838f2f373cd504a00329d53906404d1dd42a647f672af6c16f95555. Read storage, repo entrypoints, publishing, deploy paths. Policy check --canonical passes. SSD mounted /dev/disk5s4; private locked dependencies installed. Authenticated Supabase SQL and GitHub available.

Evidence: club 2a1132b9-5ba2-42e6-9f01-30a7fcffebe3 belongs to Midway Union fade0000-0000-0000-0000-000000000001. Named tables created_by joins to kingfish; PLO6 has null creator. ca_club_data_screen supplies fee and winnings from ca_club_data_fact plus currently seated cash stacks, UTC.

Read-only source reconstruction through 20:00:28: cash fee 104850.78757643998185303433 (92051 raked hands, 254 tables); tournament named fee 13747.30 plus split fee 32757.20 => total 151355.28757644, displayed 151.3K. Tournament wallet credits minus debits -47653.20, displayed -47.6K. Tournament game union from wallet and rake records 17552. Cash wallet net -128970.02 from 8330 transactions on 250 tables. Exact historical total winnings requires historical on-felt stacks, not yet established; do not certify from current stacks. Game count needs union of cash fee/wallet games and any seated-only game.

Defect: simple page counts live rows from its 200-row page instead of summary.live_games. Current independent live query found 96 cash tables plus 138 running tournaments (different read times), above cap. Fix uses server full live count with old-payload fallback. Host is read from union_clubs -> unions.name under existing authenticated RLS; unlinked club falls back to club name, never username. Advanced report also uses host and removes individual creator portrait.

Validation: TypeScript app compiler passed; 88 tests across four directly affected suites passed. Regression: named/missing creators both Midway Union, unlinked club fallback, live count beyond page. Remaining: final prechecks, protected PR merge/publication and live authenticated proof; retain exact run IDs below.
