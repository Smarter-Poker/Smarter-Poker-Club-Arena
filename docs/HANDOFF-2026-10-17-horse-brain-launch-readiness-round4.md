# Horse Brain Launch Readiness: Handoff (Round 4)

Written 2026-10-17 by the Horse Brain lead agent (session https://claude.ai/code/session_01C3jJSD1BTe1cruMm91nDJT).
Repository: Smarter-Poker/Smarter-Poker-Club-Arena. Read `docs/HANDOFF-2026-10-17-horse-brain-launch-readiness-round3.md`
first: its sections 0-2 (mission, rules, environment, program map) and 4 (requalification procedure) still hold.
This file supersedes round 3's sections 5 and 6. Lines marked [LIVE-CHECK] were true when written; re-read them.

## 1. Authorizations Dan Gave This Round (binding until he says otherwise)

- 2026-10-16 22:42 CDT "GO": cancel the CI-recovery agent's superseded e87ee1b7 strength runs that blocked the queue.
- 2026-10-16 22:48 CDT: "Authorized: production reads on the engine host and Supabase, and merging/installing your Horse
  Brain PRs". Covers read-only SSH to root@5.161.252.33 (docker inspect, /metrics via `docker exec ... node -e fetch`,
  journal completion extracts), read-only Supabase SELECTs, `gh pr merge --auto` on the lead's own Horse Brain PRs, and
  installing their migrations.
- NOT authorized: host config edits or restarts (HORSE_DECISION_WORKERS), Hetzner changes, comments on other agents' PRs,
  cancelling other agents' runs (beyond the one GO).

## 2. Done This Round

| Item                                                | PR / action                                                                                        | State [LIVE-CHECK]                                                                                                             |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Queue unblocked                                     | cancelled e87 P11 plo8 38936339073, P13 flh 38936342768, P8 38936331731 at 03:43Z                  | P10 e87 finished 04:38Z; requal queue running                                                                                  |
| Release 9ccf3e42 carries S's digests                | recomputed from its tree ~03:35Z (`hb-bundle-tmp/digests.mts`)                                     | identical to S for every phase                                                                                                 |
| P11/P12 completion, window 04:02-04:50Z on 9ccf3e42 | identity reads 04:00:30Z = 04:50:29Z                                                               | PASS all 7: plo5, plo6, plo8, flh, flo8, short_deck, pineapple (every eligible decision completed; lowest Wilson bound 0.9724) |
| P13 completion, window 04:02-05:50Z on 9ccf3e42     | identity reads 04:00:30Z = 04:50:29Z = 05:50:30Z                                                   | nlh recorded (streets all >= 0.99; boards 1 and 2 pass; boards 3 had 0 eligible). Other 8 variants: see section 3              |
| FLH strength on S                                   | run 38988196506, +1.11 [+0.70, +1.52] bb/100, 544,320 pairs, no reasons                            | qualified                                                                                                                      |
| FLH generation 4 selection                          | PR #7230 (auto-merge armed)                                                                        | merges, then engine release at a :55 break; verify receipts (section 4)                                                        |
| Tournament scoreboard                               | PR #7210 merged; migration 20261017033522 INSTALLED 05:17Z (md5 58f2ea81 -> 1c896935)              | finish percentile now 0.50 avg (was 0), satellite ROI -9.2% (was -81%)                                                         |
| Phase 14 capture slots                              | PR #7215 merged; migration 20261017040330 INSTALLED 05:40Z (4 fns rebuilt from pg_get_functiondef) | capture admitting again (19 unfinished, was stuck at 256)                                                                      |
| League completes hands like production              | PR #7221 merged (f39e9d5c), engine release at a :55 break                                          | league opponent memory now gets the hand-ending action                                                                         |

Notes:

- #7210 supersedes the scoreboard half of PR #7091 (another agent, open). Installing #7091's `20261016103322` after
  #7210 would revert the finish-percentile fix. Its V31 audit half (`20261016105000`) is independent.
- `v23_river_reads` stays inert in self-play even after #7221: league horses fold rivers 43-88%, so the read only raises
  bluffScale, which every consumer caps at 1.2-1.3 where it already sits. Production fires the read ~200k/day.

## 3. Incident: Parallel Completion Extracts Caused 410 Worker Fallbacks (2026-10-17 ~06:00Z)

To outrun journal-ring retirement the lead ran the eight remaining P13 stage-1 extracts in parallel at 05:58Z. Despite
nice 19 / ionice idle they took ~4 cores; with a load rise (dealable tables ~430 -> 556 at 06:00Z) the oldest queued
decision reached 13.4 s and `poker_horse_decision_fallbacks_total` went 0 -> 410 (horses checked/folded with no brain).
All extracts were killed at ~06:02Z; fallbacks stayed at 410 and the lane recovered.

- The eight partial extracts were discarded unread (`$HOME/agent-work/hb-compl-9ccf/ABORTED-*`).
- `docs/evidence/phase13/declaration-completion-p13-requal-bundle-2026-10-17-addendum-1.txt` (sha256 941b5556...) records
  this, makes those eight variants "not judged" by H=04 (measured in the next valid window), and adds the extraction rule:
  ONE extract at a time, killed as soon as /health oldestQueuedDecisionAgeMs > 3000 ms.
- Use `/Volumes/SmarterWork/agent-work/claude-hb-lead2-20261017/guarded-extract.sh` for every stage 1 from now on. Prefer
  low-traffic hours (07:00-13:00Z).

## 4. Requalification Status And Next Steps [LIVE-CHECK]

Single strength queue, FIFO, one league at a time:
P10 PLO4 38988202259 (started 05:38Z, 100 shards, ~2-2.5 h) -> P11 plo8 38988208052 -> plo5 38988213699 -> plo6 38988218988
-> P13 plo8, plo4, nlh, plo5, plo6, flo8, flh, pineapple, short_deck -> P12 flo8, short_deck, pineapple.
`auto-assemble.sh` (Mac, lead folder) downloads and assembles each finished S run into `$HOME/agent-work/asm-S/out-p<N>-<v>/`
(reads `verdict.qualified` into `auto-assemble.log`).

Per pack, once its strength verdict is qualified:

- P11 plo5/plo6/plo8 and P12 flo8/short_deck/pineapple: completion records already PASS (section 2), in
  `$HOME/agent-work/hb-compl-9ccf/phase1{1,2}-completion-<v>.json` (sha256 list in the lead folder
  `completion-p1112-results.txt`). Commit as `docs/evidence/phase1N/d9190c9e/phase1N-completion-2026-10-17-<v>.json`.
- P10 PLO4: no completion stage of its own (gen 2 precedent #6901): strength + selection only, generation 3.
- P13: nlh record exists; the other eight need a valid window (addendum 1), guarded, one at a time.
- Selection pattern = PR #7230 (FLH gen 4): new branch from origin/main (never reuse a merged branch), copy strength dir +
  qualification + completion into `docs/evidence/...` AND byte-identical `server/release-evidence/...`, set the selection
  constant (`issuedAt` after the window end), restore the "selected pack is usable" tests (the #7166 diff shows exactly
  what changed), full server vitest + tsc, verify hashes after the commit hook, push, PR, `gh pr merge --auto`.
- After each selection's :55 cutover: /health releaseSha, then live receipts (mode `candidate` at cash, authority
  `usable`, approvalGeneration as selected, applied) via telemetry `phase1N_authority_worker_*` and the journal.
- Generations: P10 gen 3, P11 gen 3, P12 FLH gen 4 (done), SD/Pineapple/FLO8 gen 1, P13 gen 1.

## 5. Launch-Readiness Register (Updated)

1. CAPACITY (Dan APPROVED 2026-10-17 11:09Z). At 06:00Z (01:00 CDT) with 556 tables the decision lane already sat at
   ~700 queued, oldest 6-7 s; 1,578 optional second looks expired (no fallback by themselves). Daily worker compute
   ~230,000 s, so reordering the queue cannot fix it.
   - Root fix APPROVED: rescale Hetzner 132435945 to ccx43 (16 dedicated vCPU, 64 GB RAM, 360 GB disk; lane then runs 8 workers, no code change).
   - SCHEDULED DOWNTIME: 11:55 UTC (06:55 CDT), during the :55 table break in the quiet hour window. Antigravity powers off, executes `hcloud server change-type 132435945 ccx43`, powers on, and verifies 8 workers and tournament resumption.
   - HORSE BRAIN NOTICE: Avoid running journal completion extracts across the 11:55-12:05Z window.
   - Post-rescale verification: /health releaseSha, liveHorseDecision.workerCount 8, governor.enabled false, stalledTableCount 0, tournamentResumesFailing 0, and poker_horse_decision_fallbacks_total stays flat at tonight's 23:00Z peak.
2. Requalification (section 4).
3. Tournament ICM context gaps: 79% of incomplete contexts are `live_field_recovery_pending` +
   `live_field_stack_cardinality_mismatch` (busted players holding an open rebuy/re-entry prompt; fail-closed by design;
   needs the Phase 7 rebuy option model in hashed HorseTournamentUtility, bundle with a future requalification). 16% are
   `dead_button_atlas_unsupported`.
4. Phase 7 recovery_option, PLO tournament preflop chart, exploit memory persistence, V31 solver, Phase 8 outcome model,
   human-population winning proof: unchanged from round 3 (all hashed or post-launch).
5. Repo-wide CI: "Installed and merged migrations agree" fails on every PR because another agent's
   `20261016042047_the_midway_board_and_the_diamond_arena_board_are_a_fixed_sch.sql` is merged but not live. Not required;
   not Horse Brain. Client Unit Tests shard 4 (`simple-club-data-page`) and Accounting shard 3/4 (Diamond club-commerce
   admission) flaked once each; re-run cleared them.
6. `HorseFleet.stableHandState` warning (2026-10-16 13:02Z) is still open in operational_alert_events although Stable
   Hand writes are healthy (207/1,000 rows updated in 30 min at 06:07Z). Fleet seating, not the decision brain.
7. Rotate the Vercel token seen in a process listing on 2026-10-15 (round 3 item 17).

## 6. Files

- Lead folder (99% full volume, keep big data off it): `/Volumes/SmarterWork/agent-work/claude-hb-lead2-20261017/`
  (`read-identity.sh`, `window-identity-reads-9ccf.txt`, `run-completion-9ccf.sh`, `guarded-extract.sh`, `auto-assemble.sh`,
  `completion-p1112-results.txt`, addendum, migration copies, apply logs, `queue-cancel-2026-10-17.txt`).
- Main disk: `$HOME/agent-work/src-9ccf` (clean release tree 9ccf3e42, keep clean for stage 2), `src-S` (clean S tree for
  assembly), `asm-S/`, `hb-compl-9ccf/` (extracts, records), `hb-select` (#7230 branch), `hb-tscore`, `hb-capgap`,
  `hb-league`, `hb-handoff4`.

## 7. Update 2026-10-17 20:05Z (same lead session)

### Capacity: resolved

- Hetzner 132435945 rescaled to ccx43 16:55-16:58Z (dedicated vCPU limit raised 8 -> 24, project 13956822): nproc 16,
  61 GiB, 338 GB disk. The `HORSE_DECISION_WORKERS=4` override is removed; every release since 17:31Z runs
  `workerCount 8`. `poker_horse_decision_fallbacks_total` 0 and expired jobs 0 on release 24c44521 (19:55Z).
- Still watch the 23:00Z peak once (fallbacks counter, /health `liveHorseDecision.oldestQueuedDecisionAgeMs`).

### Selections [LIVE-CHECK]

| Pack                          | Strength bb/100 (99% CI, pairs)        | Completion (lowest Wilson)                                       | PR    | State                                                        |
| ----------------------------- | -------------------------------------- | ---------------------------------------------------------------- | ----- | ------------------------------------------------------------ |
| FLH gen 4 (P12)               | +1.11 [+0.70, +1.52], 544,320          | 0.9724                                                           | #7230 | live since 06:55Z                                            |
| PLO4 gen 3 (P10)              | +6.93 [+6.25, +7.62], 2,557,440        | none (P10)                                                       | #7283 | live on 24c44521 (19:55Z); `phase10_authority_worker_usable` |
| PLO8 gen 3 (P11)              | +7.82 [+6.82, +8.82], 1,116,288        | 0.9799                                                           | #7283 | live on 24c44521; `phase11_authority_worker_plo8_usable`     |
| Crazy Pineapple gen 1 (P12)   | +1.51 [+0.95, +2.08], 3,032,640        | 0.9803                                                           | #7310 | merged 19:48Z; live at the next :55 release                  |
| PLO5 gen 3 (P11)              | +5.34 [+4.21, +6.46], 2,379,456        | 0.9853                                                           | #7313 | auto-merge armed                                             |
| PLO6 gen 3 (P11)              | run 38988218988 running                | PASS, `hb-compl-9ccf/phase11-completion-plo6.json` (48f5dca4...) | -     | assemble, then a new branch from main                        |
| Short Deck / FLO8 gen 1 (P12) | runs 38988287494 / 38988282054 pending | PASS (055bc9f8... / 3a948491...)                                 | -     | -                                                            |
| P13, 9 variants               | 9 runs pending                         | nlh only; 8 measured 2026-10-18 (below)                          | -     | -                                                            |

Verify each cutover: `/health` releaseSha equals the merge commit, then `horse_brain_telemetry` for the day:
`phase1N_authority_worker_<v>_usable` rises by 8 (one per worker) and `phase1N_applied` grows.

### New rule: a selection PR stays under 3,000 files

The required check "Money trigger declaration authority" lists PR files through the GitHub pulls API, which stops at
3,000 (`diff truncated`, the check fails). Each pack's evidence is ~900-1,950 files (runs/ ships twice), so ship one
large pack per PR, or two small ones. #7283 at 3,768 files failed; split to 1,818 it passed. The repo autopilot opens a
PR for a pushed branch by itself: edit its title and body, then `gh pr merge --auto --squash`.

### Phase 13 completion (unattended)

`claude-hb-lead2-20261017/p13-window-chain.sh 2026-10-18T06 2026-10-18T14` runs on the Mac (log
`$HOME/agent-work/hb-compl-p13/chain.log`, records `phase13-completion-<v>.json` in the same folder). Per hour H it reads
identity at H:00:30, recomputes the serving release's digests from that release's own tree (phase 13 must equal S),
re-reads identity after (H+1):50, and only then extracts the 8 variants one at a time through `guarded-extract.sh`
(declaration + addendum-1, window H:02 to (H+1):50). A changed release voids the window and it moves on. Selection PRs
cut releases at :55 breaks, so avoid merging server/ changes during 06:00-14:00Z if possible.

### Phase 15 daily report

`horse_reference_agreement_daily` for 2026-10-16 was written 07:06Z (complete). Its agreement totals are 0 because the
`phase15_reference_agreement_*` counters first fired on 2026-10-17 (3.4M fires by 18:00Z); the 2026-10-18 07:00Z run is
the first with agreement data. Policy outcomes are populated.

### Janitor

The shared clone (`~/Documents/club-arena`, mirror, never commit there) is still at 2026-10-16 07:42, so the LaunchAgent
(04:30 and 16:30 local) still runs the pre-#7284 janitor. Every lead worktree is `git worktree lock`ed so it is skipped;
lock any new worktree before leaving it.

## 8. Codex Resumption 2026-10-18 13:43Z: Prior Selection Instructions Superseded

The owner resumed Horse Brain in Codex chat 01a14f3e-ae69-7333-9f79-eb2ce71ffb93.
Checkout: `/Volumes/SmarterWork/agent-work/horse-brain-resume-20261018-01a14f3e/repo`,
branch `codex/horse-requalification-resume-20261018`, base `6afa6822c3e09942aa3daf6149e55ea33903a21f`.
Evidence: `/Volumes/SmarterArchives/agent-evidence/horse-brain-resume-20261018-01a14f3e`.
Scope remains the existing Horse Brain qualification, selection, release and natural proof; no new strategy phase.

Current policy 2.9 read with canonical reader at 2026-10-18T13:41:25.330Z; manifest
`a659f31c5c1c2b0864889508079a635dd5fe2fc98decfbfc9d3f9c80dd45ec3b`.
Canonical paths read: `/Users/smarter.poker/Documents/AGENTS.md`, `AGENT-OPERATING-LAW.md`,
`AGENT-HARDENING-STANDARD.md`, `AGENT-REFERENCE-INDEX.md`; repository entrypoints,
`PUBLISHING.md`, deploy-paths and the recovered round-3/4 handoffs also read.
Portable policy check against canonical passed. Policy file SHA256 receipts:
OWNER b9478d0331314413d8e12c41210b63479cdcabc1f86ed3fdcb3251efa36e6349;
OPERATING a8bc3c04dce3354ebdd51a89c0b7d715af3344edcc794d33f6b3ad64506961d5;
HARDENING d5fc451ce5caf6d6b5e64597a13883e1246581678fe53c962339d0a66136993e;
INDEX adce89c3f838f2f373cd504a00329d53906404d1dd42a647f672af6c16f95555.

### Critical recovery finding

PR #7323 merged `f56b42dd8bb290fb2f929d845067cd58b35e6ef1` at 2026-10-17T23:13:22Z.
The owner explicitly chose "Ship now, requalify all" for the VPIP-floor call-down.
It changed hashed `HorseLogic.ts` and set all P10/P11/P12 selections to null.
Therefore no d9190c9e matrix or completion record can authorize a selection on the current source,
including PLO6 run 38988218988 (244 shards, qualified on the old policy). PR #7331
changed tooling only; its archived PLO6 evidence is retained historical evidence.

Engine health and authenticated container inspection at 13:41-13:43Z both identify
`da94e43740fa4940e7d1f6e4488264c2b6ffb58a`; eight workers ready, zero expired jobs,
`poker_horse_decision_fallbacks_total 0`. Current main has no server difference from that release.
The old unattended P13 windows at H=06,08,10 were voided by changed container StartedAt
even though the SHA stayed da94e437. The old H=12 window cannot qualify the new policy
because it was declared against S's digests. Preserve its records; do not relabel it.

### Recovery actions and acceptance

Retire only superseded d9190c9e Horse Brain strength runs owned by this resumed assignment;
retain completed artifacts and inspect terminal remote outcomes. Stop the two inherited stale
assembly/completion scripts before they write more internal-drive files or judge obsolete windows.
Dispatch the same 17 locked matrices against protected serving source da94e437, prioritizing
FLH, PLO4, PLO8, PLO5, PLO6 and Pineapple. No seed/contract/threshold changes.
Fresh natural completion needs a declaration bound to current policy digests and unchanged identity;
one guarded extract at a time, abort on unreadable health or oldest queued decision above 3000 ms.
Selection requires positive strength, completion where applicable, matching digests, next generation,
byte-identical shipped evidence, required checks, protected merge, certified activation and natural use.
No old result is promoted and no restart is initiated to create evidence.

### Production restart cause and source repair

Docker inspection reported RestartCount 54 at 13:45Z, with no cgroup memory limit
and OOMKilled false. At 13:43:51Z the log shows `reference_shape` from the
live decision client, followed by GameServer.Uncaught_exception and fatal shutdown.
At 13:44:31Z graceful ownership release timed out; the process exited 1 and
Docker restarted it at 13:44:32Z. A zero fallback counter after reboot does not
prove an error-free earlier interval. The narrow log extract is retained in evidence.

Reproduced offline through real HorseLogic and live-client validation: a chart
fold converted by the new VPIP-floor call-down is rejected as reference_shape.
Two regressions failed before the repair; the focused 395-case run passed after it.
`HorsePhase6Attribution.referenceReturnShape` now asks the existing bounded
call-down owner whether a fold can become exactly the returned call, with a
constant zero callback to test positive probability. It draws no RNG, repeats
no chart/equity decision, and retains route, graph, snapshot and malformed-call
refusals. Strategy, floor values and action probabilities are unchanged.
The attribution module is an explicitly excluded diagnostic boundary in
HorseReferenceDecisionSources; every P10-P13 policy digest remains unchanged.
New-source strength work therefore remains applicable to the receipt repair.

The two inherited stale scripts were stopped; their retained files and completed
artifacts were preserved. Ten superseded d9190c9e runs are terminal cancelled.
Seventeen new locked matrices were dispatched against da94e437 with no contract,
seed or threshold changes. These are qualifications, not releases or admissions.

| Phase | Variant    | Owning run  |
| ----- | ---------- | ----------- |
| 10    | plo4       | 39132884688 |
| 11    | plo6       | 39132893655 |
| 11    | plo5       | 39132890865 |
| 11    | plo8       | 39132887881 |
| 12    | short_deck | 39132902549 |
| 12    | flo8       | 39132899869 |
| 12    | pineapple  | 39132896867 |
| 12    | flh        | 39132882188 |
| 13    | short_deck | 39132934384 |
| 13    | pineapple  | 39132931791 |
| 13    | flh        | 39132929267 |
| 13    | flo8       | 39132925719 |
| 13    | plo6       | 39132922262 |
| 13    | plo5       | 39132918721 |
| 13    | nlh        | 39132915126 |
| 13    | plo4       | 39132910448 |
| 13    | plo8       | 39132906218 |

Fresh completion declaration: `docs/evidence/phase12/declaration-completion-vpip-repair-2026-10-18.txt`.
No window has been opened or certified. No pack is selected by this repair.
Next generations: P10 PLO4 4; P11 PLO5/PLO8 4, PLO6 3; P12 FLH 5,
Pineapple 2, Short Deck/FLO8 1; P13 1. Read retained generations before issuing.
Source, checks, protected merge, installed release and natural proof remain distinct.

### Exact-candidate local checks (2026-10-18)

- Root `npm run typecheck`: passed. Server `npx tsc --noEmit`: passed.
- Full server `npx vitest run`: 22,767 passed, 168 existing skips, one environment
  failure: the long task TMPDIR exceeded PostgreSQL's Unix socket path limit in
  RebuyFormatMoney.guard.test.ts. No source assertion failed. The same unchanged
  failed test is rerun with short task-owned SSD TMPDIR
  `/Volumes/SmarterWork/agent-work/hbr-01a14f3e-t` (server-socket-recheck.log).
- All 17 P10-P13 policy digests were recomputed after the source repair and
  match the pre-repair da94e437 values exactly. No strategy file was changed.
- Production log evidence: `production-reference-shape-fatal.log`; red regressions:
  `reference-red-server.log`; focused green: `reference-green.log`; full suite:
  `server-full.log`; typechecks and socket recheck are beside them in the evidence root.
- Superseded-run jobs were read through every page: all 154 jobs of the active
  old P13 PLO4 run are terminal; the other nine cancelled pending runs had no jobs.
- FLH run 39132882188 has begun its locked 42-shard league. Other new-source runs
  remain in the provider's existing serial league queue. No release was dispatched
  by a scheduler, inherited script or qualification job.

Protected merge, owning stage/receiver, certified activation, exact public/local
release identity and natural absence of the reproduced rejection remain pending.
