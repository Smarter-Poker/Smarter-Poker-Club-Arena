# Horse Brain Launch Readiness Handoff (2026-10-15 14:15Z)

Written by the Horse Brain takeover agent (session https://claude.ai/code/session_01WM1mgwwZpVw6CFUNDKL4LL).
The full handoff prompt, with every detail, is in this file's section 0 through section 14. Read all of it before touching anything.

## 0. Ground Rules For The Next Agent

- Scope is Horse Brain ONLY. Dan said on 2026-10-14: "ONLY WORK ON THE HORSE BRAIN, LIGHTNING GAMES IS FOR SOMEONE ELSE."
- Horses are players, never "bots" (CLAUDE.md 10.5). Never filter horses out of anything.
- Dan does not want options or questions. Decide, act, report. No interim status updates. No sleep loops: never wait on a timer when there is other work; if the only remaining work is time-bound (a declared window), say so and stop.
- Read root `CLAUDE.md`, `AGENTS.md`, `AGENT-PLAYBOOK.md`, `PUBLISHING.md`, `docs/agent-policy/REFERENCE-INDEX.md` at task start.
- Delivery: owned branch, PR, required checks (TypeScript Check, Client Unit Tests (vitest), Server Engine (typecheck + tests), Production Build, CSS Beat E2E, Money trigger declaration authority), protected squash merge. `smarter-poker-autopilot[bot]` auto-merges green PRs and auto-creates PRs for pushed branches. Engine releases: `stage-engine-release.yml` then `auto-deploy-hetzner.yml` ("Engine Release <sha>"), cutover at the hourly :55 break. Verify `https://engine.smarter.poker/health` `releaseSha`.
- "Installed and merged migrations agree" fails on every PR because migration `20261012054804_a_closed_target_pays_its_satellite_tickets_in_cash.sql` (#6723) was merged but never installed. It is NOT a required check and NOT Horse Brain scope (it does affect 928 tickets worth 55,120.00 held by 460 horse players; report it to whoever owns satellites).

## 1. Machines, Paths, Access

- Dan's Mac Studio (`SmarteracStudio`, user `smarter.poker`) reached through the linked-device shell. `gh` at `/opt/homebrew/bin/gh` (authenticated as Smarter-Poker); node `~/.nvm/versions/node/v24.15.0/bin` (node 26 is default, CI uses 22). `timeout` is not installed on macOS.
- The bridge times out a call after 60s: run anything long with `nohup ... &` and poll a log file.
- ALWAYS set `TMPDIR=/Volumes/SmarterWork/agent-work/claude-takeover-20261014/tmp` (or another owned dir on the SmarterWork SSD) for vitest and pre-push. With `/tmp` two tests fail for environment reasons (`RebuyFormatMoney.guard.test.ts` demands an SSD TMPDIR; `an-operational-alert-sender-addresses-the-fleet.decisions.test.ts` breaks on /tmp vs /private/tmp).
- Pushing over SSH dies (exit 141) when the pre-push hook runs for minutes. Push over HTTPS instead:
  `git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena.git HEAD:refs/heads/<branch>`
- Something prunes `node_modules` inside worktrees to save space (SmarterWork is about 89% full). If imports fail, run `npm ci --no-audit --no-fund --cache <owned cache>` at the root and in `server/`.
- Engine host: `root@5.161.252.33`, key `/Users/smarter.poker/.ssh/hetzner_engine_key`, container `club-arena-engine` (labels `sp.release.sha`), journal `/var/lib/club-arena/horse-decisions` (archive shards `archive/segments`, `archive-shard-N/segments`). Read only, always `nice -n 19 ionice -c3`.
- Supabase project `kuklfnapbkmacvwxktbh` (PokerIQ-Production). The cloud session's GitHub token cannot dispatch workflows (403) and its proxy blocks the npm registry; dispatch and npm from the Mac.
- Takeover working folder: `/Volumes/SmarterWork/agent-work/claude-takeover-20261014/` (logs, extracts, completion records, declarations, downloaded strength runs, worktrees `src-c92768c`, `src-38e91da`, `src-c84a2bc`, `flh-select`, `plo4-select`, `p11-select`, `p11b-select`, `p13-evidence`).

## 2. Program Map (Phases 1 to 15)

Contract and playbook: `docs/horse-brain-round1-playbook.md`, winning contract `docs/horse-brain-winning-contract-2026-10-08.md`, Phase 12 round 4 record `docs/horse-brain-phase12-round4-2026-10-11.md`. Dan's standing decision (Oct 2026): horses must be winning players; a strategy is switched on only once it beats the current brain; proving it wins against humans waits until after launch.

Authority files (one selection constant per phase; null = shadow):

- Phase 8 tournament postflop: `server/src/engine/HorseQualifiedAuthority.ts` `PHASE8_PROTECTED_RELEASE_SELECTION` (null).
- Phase 10 PLO4: `server/src/engine/HorsePhase10Authority.ts` `PHASE10_PROTECTED_RELEASE_SELECTION` (generation 2, LIVE).
- Phase 11 PLO5/PLO6/PLO8: `server/src/engine/HorsePhase11Authority.ts` `PHASE11_PROTECTED_RELEASE_SELECTIONS` (all generation 2, LIVE).
- Phase 12 Short Deck/Pineapple/FLH/FLO8: `server/src/engine/HorsePhase12Authority.ts` `PHASE12_PROTECTED_RELEASE_SELECTIONS` (FLH generation 3 LIVE; others null).
- Phase 13 joint multiway (nlh, plo4, plo5, plo6, plo8, flo8, flh, pineapple, short_deck): `server/src/engine/HorsePhase13Authority.ts` `PHASE13_PROTECTED_RELEASE_SELECTIONS` (ALL null; never selected yet).
- Phase 14: `server/src/engine/HorsePhase14Authority.ts`.
- Phase 15 replay: `server/src/engine/horseDecision/replay/*` (exact replay, qualified authority replay).
- Historical selections kept for refusal tests: `server/src/engine/HorsePreviousSelections.test-support.ts`.
- Evidence must ship byte-identical under `server/release-evidence/docs/evidence/...` (law `server/src/engine/aSelectedPackShipsItsEvidence.law.test.ts`).
- Strength workflows (manual dispatch from main, exact 40-hex commit on main): `.github/workflows/horse-phase{8,10,11,12,13}-strength-league.yml`. Assemblers: `server/scripts/phase{8,10,11,12,13}-strength-assemble.mjs` (run in a CLEAN checkout of the measured commit with prettier installed). Completion extract stage 1: `server/scripts/phase1{1,2,3}-completion-extract.py` on the engine host; stage 2 `server/src/scripts/phase1{1,2,3}CompletionRecord.ts`.
- Completion floor: Wilson lower bound at z = 2.5758293035489 of at least 0.95 with at least 127 eligible per street (Phase 13 also per board count). Window must be predeclared in writing before it opens; release unchanged across it (StartedAt + label + /health read before and after); issuedAt of the selection after the window end.

## 3. Work Completed And Verified Live (2026-10-14/15)

| PR      | What                                                                                                                    | Merge                | Live proof                                                              |
| ------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------- | ----------------------------------------------------------------------- |
| #6765   | FLH generation 2 (earlier agent)                                                                                        | 2026-10-12           | superseded                                                              |
| #6766   | Decision lane uses host cores within journal disk bounds (third worker)                                                 | 9d656e90             | 3 workers on 38e91da; NOTE now 2 on e848247 (section 6.1)               |
| #6775   | Phase 15 replays original qualified strategy admissions                                                                 | b0601c3e             | merged                                                                  |
| #6777   | Opponent reads: raise after call counts as PFR; all-in calls not aggression; returned PLO4/5/6/8/FLH selections to null | c92768c8 (autopilot) | release c92768c8 served 23:55Z Oct 14                                   |
| #6886   | Fixed 12 tests broken by #6775+#6777 landing together                                                                   | 38e91da3             | main green                                                              |
| #6892   | FLH generation 3 (+1.11 [+0.70,+1.52] bb/100, run 38656879989)                                                          | 075cc36f             | 514 FLH cash decisions 04:00-04:15Z candidate, usable gen 3, 38 applied |
| #6901   | PLO4 generation 2 (+6.94 [+6.25,+7.62], run 38656872350, 2,557,440 pairs)                                               | ed082048             | cash candidate usable gen 2; tournaments shadow by design               |
| #6917   | PLO8 generation 2 (+7.84 [+6.84,+8.84], run 38656878018)                                                                | 655469f9             | 387 cash decisions candidate usable gen 2                               |
| #6927   | PLO5 (+5.37 [+4.25,+6.49], run 38656874186) and PLO6 (+3.68 [+2.89,+4.47], run 38656876020) generation 2                | 2dbf2a49             | PLO5 179 cash / PLO6 68 cash candidate usable gen 2                     |
| this PR | Phase 13 PLO8/PLO4 qualification evidence, declarations, identity reads, this handoff                                   | pending              | evidence only, nothing selected                                         |

Requalification source for all five: c92768c85bc53a4a5a5972d09c6ee58561010035. Natural completion window: declaration `docs/evidence/phase12/declaration-completion-pfr-repair-2026-10-14.txt` (sha256 194532d8...), window 2026-10-15T00:02:00.000Z to 00:50:00.000Z on release c92768c8 (StartedAt 2026-10-14T23:55:32Z; reads `docs/evidence/phase12/window-identity-reads-pfr-repair-2026-10-15.txt`). Lower bounds: FLH 0.9932/0.9865/0.9847/0.9807; PLO5 0.9986/0.9942/0.9924/0.9932; PLO6 0.9980/0.9929/0.9895/0.9908; PLO8 0.9979/0.9895/0.9904/0.9864. Evidence directories `docs/evidence/phase1{0,1,2}/c92768c8/`.

Expected policy digests at c92768c8: P10 PLO4 a2265ab9..., P11 PLO5 52440150..., PLO6 670b01e5..., PLO8 a5daefa9..., P12 FLH 67f964ba...; contracts P10 83ab185b..., P11 5b93ae20..., P12 FLH fafbba8d....

Engine serving at handoff: e848247e14b50893666d332f300fb59c25bf4b37 (descendant of all of the above).

## 4. Phase 13 Joint Multiway: Current State

- Strength source c84a2bcff23bb36354e421a38433baf6a3c4881a (digests: PLO8 9b271791e6f2b66a35ae91b4db519123bca02a93ba8b37f7b0cb025d3e88202c, PLO4 784c0d150803c7b65eae09ccbadc6bb917e4ccf477f3cbfb38c9dbc75d7ef625, contract 0cd88d970c600fb64933337672af349e9d106402d4edfcc3510e1f26374741f8). The policy source files did not change through e848247 (checked against 928b687 and 2dbf2a4; recheck with `git diff --stat <c84a2bc> <release> -- $(HORSE_PHASE13_POLICY_SOURCE_FILES)`).
- PLO8 (run 38698857809): QUALIFIED, 874,368 pairs, +55.70 bb/100 primary; boards 1: +12.35 [+10.51,+14.19]; 2: +154.1; 3: +217.5. qualification sha256 a832263f..., strength sha256 022b16a0.... SELECT IT once its completion record meets the floor.
- PLO4 (run 38698861116): contract QUALIFIED (+16.06 [+14.47,+17.64]) but single-board LOSES: -1.72 [-2.85,-0.60] bb/100 (boards 2: +44.4, 3: +94.4). Admission cannot restrict board counts by strength (only by completion), so DO NOT SELECT PLO4 Phase 13 until the single-board joint policy is fixed and re-measured. qualification sha256 de95bcb7..., strength 71f94222....
- Completion: declaration `docs/evidence/phase13/declaration-completion-p13-2026-10-15.txt` (sha256 c9263cfa..., written 09:10:07Z). Window rule: [H:02, (H+2):50) on the release serving at a read taken H:00-H:02, H = first whole hour with no auto-deploy-hetzner/Engine Release run queued or in progress; void if the release changes. Attempt 1 (H=12, release 2dbf2a49) VOID: release 928b6875 cut over at 12:55:56Z. H=13 and H=14 not eligible (release e848247e queued/in progress, its "Dispatch Exact Cross-Artifact Production Certification" job sat queued). Reads: `docs/evidence/phase13/window-identity-reads-2026-10-15.txt`.
- One-hour windows are too small for PLO8 (2026-10-11 window had only 96 eligible river decisions < 127). Use the declared 2h48m window. If releases keep landing hourly, coordinate a quiet period or write a new predeclaration (never re-measure the same release window after seeing results).
- To finish PLO8 Phase 13: (1) at an eligible H read identity between H:00 and H:02 (`docker inspect club-arena-engine --format '{{.State.StartedAt}} {{index .Config.Labels "sp.release.sha"}}'` and /health); (2) after (H+2):50 read again and confirm no auto-deploy success between; (3) stage 1 `ssh ... "nice -n 19 ionice -c3 python3 - <from> <to> <release> plo8" < server/scripts/phase13-completion-extract.py > extract.ndjson`; (4) stage 2 in a clean worktree of the release `cd server && node --import tsx src/scripts/phase13CompletionRecord.ts --variant=plo8 --release=<sha> --from=<from> --to=<to> --release-unchanged=true --source="<declaration + window>" < extract.ndjson > phase13-completion-<date>-plo8.json`, prettier 3.8.1; (5) if every street clears, add `PHASE13_PROTECTED_RELEASE_SELECTIONS.plo8` (approvalGeneration 1, qualificationPath `docs/evidence/phase13/c84a2bcf/phase13-qualification-2026-10-15-plo8.json`, sha256 a832263f5a365fc4875b59f349b3459f6bc898c02621cf9ee70c4cd86dbdb8c0, completion path/sha, issuedAt after window end), copy qualification + strength + completion into `server/release-evidence/docs/evidence/phase13/...`, deliberately update `server/src/engine/HorsePhase13Authority.test.ts` (the "all null" tests at about lines 135-300 are written to fail until updated), run the full server suite, push over HTTPS, merge, verify after the next :55.

## 5. Not Started Or Not Passing (Launch Readiness Register)

1. Phase 13 PLO8: qualified, needs completion window + selection (section 4).
2. Phase 13 PLO4: single-board loss; needs a single-board joint policy fix, re-run `horse-phase13-strength-league.yml` variant plo4, then completion + selection.
3. Phase 13 NLH: last run (1235b47a, 2026-10-10) NOT qualified (3dealt interval not trusted; bomb1 profile, small blind and big blind regression margin exceeded). Needs strategy work then re-run.
4. Phase 13 PLO5, PLO6, FLO8, FLH, Pineapple, Short Deck: never measured on the current source (the 5adefba4 runs were cancelled Oct 8). Dispatch one at a time (each is about 140-250 shards) so runners are not starved.
5. Phase 12 Short Deck, Crazy Pineapple, FLO8: no qualification under their per-pack contract v2; stay shadow. Need strategy work + strength + completion + selection.
6. Phase 8 tournament postflop: selection null; tournament objectives are "unavailable dependency" in every contract (no whole-tournament outcome model, no qualified tournament reference population, no tournament thresholds). All promoted packs are cash-only by design; Phase 7 owns tournament utility.
7. V31 solver commissioning (`docs/HANDOFF-2026-10-05-v31-solver-commissioning-PROMPT.md`): needs the two licensed PioSOLVER Windows hosts M1 (train) and M2 (holdout). They last reported in `solver_worker_liveness` on 2026-10-07 (pilot manifest relative-v2-pilot-20261007-r1, solver 3.8.0). `gto_v31_datasets` rows remain `building`; no qualified dataset; engine `postflopV31: 0`. Blocker: host access (needs Dan to power on / link M1 and M2). Later enhancement, not a baseline requirement.
8. Third decision worker: `/health.liveHorseDecision.workerCount` was 3 on 38e91da but is 2 on e848247 (host 8 cores, root disk 17G free of 75G; journal compressed ring at its 8 GiB cap). #6766 bounds the worker count by journal disk, so 2 may be the correct admission now. Read lane.ts admission logs/health to confirm the reason; if it is a regression, fix it.
9. Human-population proof of winning: deferred by Dan until after launch.
10. CI capacity: strength leagues (hundreds of hosted jobs) starve every agent's CI and engine releases (an Engine Release deploy job waited about 30 minutes). Add `strategy.max-parallel` to the strength workflows or run them off-peak. Not done.

## 6. Notes And Pitfalls Learned

6.1 Worker count above. 6.2 `gh api .../actions/runs/<id>/jobs` often returns HTTP 502 on page 2+; use per_page=50. 6.3 Strength runs cancelled to free runners can be resumed with `gh run rerun <id> --failed`; assemblers count the earliest complete attempt and record cancelled attempts. 6.4 Assemblers refuse a dirty checkout: move outputs out of the measured worktree between assemblies. 6.5 Autopilot merges any green PR it sees, including another agent's; two individually green PRs can break main together (that is what #6886 fixed). 6.6 Extraction commands for live verification of a pack: phase11 extract with variant patched for plo4 (see `plo4-live-check.py` in the takeover folder), count receipts by (gameMode, mode, applied, authority.state, approvalGeneration).

## 7. Lightning (NOT Horse Brain)

Handed back to its own owner on Dan's instruction. For the record only: Phase 1 repair #6769 merged/installed/published; Phase 2 PR #6881 merged by autopilot (included a pilot-report extension for populated house-board Clusters, because `club_members_bot_house_only` forbids horses in the private pilot club).
