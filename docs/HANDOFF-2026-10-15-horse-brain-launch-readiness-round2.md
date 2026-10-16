# Horse Brain Launch Readiness: Military Grade Handoff (Round 2)

Written 2026-10-15 23:30 UTC by the Horse Brain takeover agent (session https://claude.ai/code/session_01THJQ8mhLsuDwLCpJq2QFfr).
Repository: Smarter-Poker/Smarter-Poker-Club-Arena. Supersedes the "next actions" of
`docs/HANDOFF-2026-10-15-horse-brain-launch-readiness.md` (round 1, PR #6968, still the reference for everything before
2026-10-15 14:30 UTC). Read both. Where they disagree, this file wins.

## 0. Mission And Rules Of Engagement

- Mission: drive Dan's Horse Brain program (the decision brain of Club Arena's AI players, called HORSES, never "bots")
  to launch ready. Scope is Horse Brain ONLY. Lightning and every other programme belong to other agents.
- Dan does not take questions or options: decide, act, report. No interim progress updates. Finish the whole job.
- Horses are players (CLAUDE.md 10.5). Never filter horses out of anything.
- Dan's standing strategy rule: horses must be WINNING players. A strategy is switched on only after it beats the
  current brain (locked strength matrix after rake against the horse population) and passes a predeclared natural
  completion window. Proof against human players waits until after launch (Dan's decision).
- Read at start: root `CLAUDE.md`, `AGENTS.md`, `AGENT-PLAYBOOK.md`, `PUBLISHING.md`,
  `docs/agent-policy/REFERENCE-INDEX.md`, `docs/horse-brain-round1-playbook.md` (phases 1 to 15),
  `docs/horse-brain-winning-contract-2026-10-08.md`, `docs/horse-brain-phase12-round4-2026-10-11.md`, the round 1
  handoff above, and the changelogs listed in section 3.
- Delivery: owned branch, PR (the `Agent Open PR` workflow opens one automatically for a pushed `claude/*` branch and
  `Agent Autopilot` arms protected squash auto-merge on `opened`/`synchronize`), required checks, squash merge.
  Required checks: TypeScript Check, Client Unit Tests (vitest), Server Engine (typecheck + tests), Production Build,
  CSS Beat E2E (multi-table + animations), Money trigger declaration authority. Engine changes go
  `stage-engine-release.yml` -> `auto-deploy-hetzner.yml` ("Engine Release <sha>") -> cutover at an hourly :55 break
  (sometimes earlier: 818b10c1 cut over 17:41:51Z). Verify `https://engine.smarter.poker/health` releaseSha.
- NEVER push to a branch whose PR already merged (CLAUDE.md 10.82): the commit vanishes. Make a new branch from
  `origin/main` and cherry-pick. This happened once today (declaration amendment, recovered as #6999).
- "Installed and merged migrations agree" fails on every PR (migration
  `20261012054804_a_closed_target_pays_its_satellite_tickets_in_cash.sql`, #6723, merged never installed; 928 tickets,
  55,120.00, 460 horse holders). Not a required check, not Horse Brain scope. Tell its owner; do not fix it here.

## 1. Environment And Access (Measured Today)

- Dan's Mac Studio (`SmarteracStudio`, user `smarter.poker`) through the linked-device shell
  (`mcp__remote-devices__counselors__host_terminal`). EACH CALL DIES AT ABOUT 60 SECONDS. Run anything longer
  double-forked so it survives the call:
  `( nohup bash -c "<cmd>" > <log> 2>&1 </dev/null & )` then poll the log. A plain `nohup ... &` is killed with the
  call's process group. macOS has no `timeout`.
- PATH: `export PATH=/opt/homebrew/bin:$HOME/.nvm/versions/node/v24.15.0/bin:$PATH` (gh authenticated as
  Smarter-Poker). CI runs Node 22.
- TMPDIR: always `TMPDIR=/Volumes/SmarterWork/agent-work/claude-takeover-20261014/tmp` for vitest and git push.
- Push over HTTPS only (SSH dies with exit 141 during the multi-minute pre-push hook):
  `TMPDIR=<tmp> git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena.git HEAD:refs/heads/<branch>`
  The pre-push hook takes 6 to 8 minutes. Never `--no-verify`.
- THE SMARTERWORK SSD IS FULL: `/Volumes/SmarterWork` had 2.2 GiB free at 23:05Z (99 to 100%). The main disk
  (`$HOME`, /System/Volumes/Data) has about 488 GiB free. Put NEW worktrees and downloads under `$HOME/agent-work/`.
  Deleting the old takeover worktrees was refused by the safety classifier; ask Dan, or leave them.
- Something prunes `node_modules` in worktrees: `src-3002fe2/node_modules` (root) vanished, `src-3002fe2/server/node_modules`
  survived. If imports or prettier fail: `npm ci --no-audit --no-fund --ignore-scripts --cache <owned cache>` in the root
  (and `server/` if needed). The assemblers refuse with `prettier_unavailable` when the root has no prettier.
- Cloud Claude sessions: GitHub REST works (gh api), GraphQL often does not, workflow dispatch 403s, the npm registry
  and engine.smarter.poker are blocked by the proxy. Dispatch and npm from the Mac.
- Engine host: `root@5.161.252.33`, key `/Users/smarter.poker/.ssh/hetzner_engine_key`, container `club-arena-engine`
  (label `sp.release.sha`). Horse journal `/var/lib/club-arena/horse-decisions` (`archive`, `archive-shard-1`,
  `archive-shard-2`, each `segments/`; owned root 700). Read only, always `nice -n 19 ionice -c3`.
- Claude's auto-mode safety classifier refused, at various times today: ssh reads of the engine host ("Production
  Reads"), `docker exec` into the container, a background chain dispatcher ("Unauthorized Persistence"), re-arming
  auto-merge ("Merge Without Review"), `gh pr create` ("Production Deploy"), `git worktree remove` ("Irreversible Local
  Destruction"). Dan has since said "I APPROVE EVERYTHING". If refused again, retry once; the same ssh reads were
  allowed at 17:58, 20:00, 21:16 and 22:00Z. Never run long-lived background loops; do waits inside the session.
- Supabase project `kuklfnapbkmacvwxktbh` (PokerIQ-Production): SELECT only for this work.
- Takeover folder: `/Volumes/SmarterWork/agent-work/claude-takeover-20261014/` (section 8 lists every file).

## 2. Program Map (Phases 1 To 15)

Defined in `docs/horse-brain-round1-playbook.md`. Authority is one committed selection constant per phase and
variant; `null` means shadow.

| Phase                            | Owner file                                               | Selection constant                     | State at 23:30Z                                       |
| -------------------------------- | -------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------- |
| 8 tournament postflop            | `server/src/engine/HorseQualifiedAuthority.ts`           | `PHASE8_PROTECTED_RELEASE_SELECTION`   | null                                                  |
| 10 PLO4 single board             | `server/src/engine/HorsePhase10Authority.ts`             | `PHASE10_PROTECTED_RELEASE_SELECTION`  | generation 2 LIVE (cash)                              |
| 11 PLO5/PLO6/PLO8                | `server/src/engine/HorsePhase11Authority.ts`             | `PHASE11_PROTECTED_RELEASE_SELECTIONS` | all generation 2 LIVE                                 |
| 12 short_deck/pineapple/flh/flo8 | `server/src/engine/HorsePhase12Authority.ts`             | `PHASE12_PROTECTED_RELEASE_SELECTIONS` | FLH generation 3 LIVE; others null                    |
| 13 joint multiway (9 variants)   | `server/src/engine/HorsePhase13Authority.ts` (line ~607) | `PHASE13_PROTECTED_RELEASE_SELECTIONS` | ALL null, never selected                              |
| 14                               | `server/src/engine/HorsePhase14Authority.ts`             |                                        | see round 1 handoff                                   |
| 15 replay                        | `server/src/engine/horseDecision/replay/*`               |                                        | live (exactReplay, qualifiedAuthority, runtimeReplay) |

Supporting: `server/src/engine/HorsePreviousSelections.test-support.ts` (retained selections for refusal tests),
`HorsePhase1{0,1,2,3}Authority.test-support.ts` (in-memory qualifications), evidence copies under
`server/release-evidence/docs/evidence/...` (law `server/src/engine/aSelectedPackShipsItsEvidence.law.test.ts`).
Strength workflows (manual dispatch from main, `source_sha` an exact 40-hex commit on main):
`.github/workflows/horse-phase{8,10,11,12,13}-strength-league.yml` (all have `max-parallel` 18 to 20; register item 10
of round 1 is DONE). Assemblers: `server/scripts/phase{8,10,11,12,13}-strength-assemble.mjs`. Completion: stage 1
`server/scripts/phase1{1,2,3}-completion-extract.py` on the engine host; stage 2
`server/src/scripts/phase1{1,2,3}CompletionRecord.ts`.

Phase 13 policy digest: `server/src/engine/HorsePhase13PolicyDigest.ts`. One digest per variant, but the hashed file
list (36 files, `HORSE_PHASE13_POLICY_SOURCE_FILES`) is SHARED, and it includes `HorseLogic.ts`,
`HorsePolicyRegistry.ts`, `PokerEngine.ts`, `BettingStructure.ts`, `VariantRules.ts`, `HorseEval.ts`,
`remainingVariants/RemainingVariantPolicyPack.ts`, `plo4/Plo4PolicyPack.ts`, `omaha/OmahaVariantPolicyPack.ts` and the
whole `multiway/` closure. ANY edit to any of those files (by anyone) changes all nine Phase 13 digests and voids every
Phase 13 qualification made before it. Check before every window:
`sed 's#^#server/#' p13-policy-files.txt | xargs git diff --stat <qualified-source> <serving-release> --`.

## 3. Done And Verified Today (2026-10-15, After Round 1)

| PR    | Merge           | What                                                                                                                                                                                                      | Verified                                                                                      |
| ----- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| #6968 | babe2524        | round 1 evidence + handoff                                                                                                                                                                                | merged 15:21Z                                                                                 |
| #6972 | 9970aa0c        | journal disk walk accepts `du` exit 1 when only retired segments vanished                                                                                                                                 | live 16:55Z (still 2 workers then)                                                            |
| #6973 | 818b10c1        | `JOINT_SELECTION_RULE.singleBoardCashKeepsVariantBrain = ['nlh','plo4']`: single-board cash NLH/PLO4 keep the variant brain; candidates still priced and recorded                                         | live 17:41:51Z                                                                                |
| #6988 | b1aaf663        | Phase 13 completion declaration for source 818b10c1                                                                                                                                                       | merged 18:16Z                                                                                 |
| #6991 | a2ccc04d        | journal capacity measured off the event loop (90 s async `du`, `horseJournalShardCapacityMeasured`), reason published on `/health.liveHorseDecision.journalCapacityUnreadable` and `journalShardCapacity` | live 20:55:52Z; /health workerCount 3, journalShardCapacity 3, journalCapacityUnreadable null |
| #6999 | (merged 20:31Z) | declaration amendment (trailing jobs of the serving release's own run do not void a window) + H=18 void record + identity reads                                                                           | merged                                                                                        |

Changelogs: `docs/changelog/2026-10-15-the-journal-walk-survives-a-retired-segment.md` (with two follow-up sections),
`docs/changelog/2026-10-15-single-board-cash-stays-with-the-variant-brain.md`.

Register item 8 of round 1 (decision workers 2 instead of 3): DONE. Cause: `horseJournalShardCapacity` refused the
reading (retired segments mid-walk; 9.9 s warm walk against a 15 s synchronous limit). Fixed in #6972 + #6991.
Register item 10 (max-parallel on strength workflows): already done on main before today.

Why #6973 (the single-board rule). Locked P13.2 matrices, joint owner minus current brain, bb/100 after rake, 99%:

| Variant | Source   | 1 board                                                   | 2 boards | 3 boards |
| ------- | -------- | --------------------------------------------------------- | -------- | -------- |
| PLO8    | c84a2bcf | +12.35 [+10.51, +14.19]                                   | +154.1   | +217.5   |
| PLO4    | c84a2bcf | -1.72 [-2.85, -0.60]                                      | +44.4    | +94.4    |
| NLH     | 1235b47a | -9.19 [-9.84, -8.54] (bomb1 -38.58, SB -29.48, BB -12.14) | +13.7    | +82.8    |

Implementation: `server/src/engine/multiway/JointActionModel.ts` (`JOINT_SELECTION_RULE`, `jointSingleBoardCashActs`),
`server/src/engine/multiway/JointLivePolicy.ts` (`jointSelectedRow`: `keepsVariantBrain` empties the candidate scan for
cash, boardCount 1, listed variant). Tests: `server/src/engine/multiway/JointSingleBoardCash.test.ts`, pin in
`JointResponseCalibration.test.ts`, NLH wiring spot moved to `{ street: 'flop', boards: 2, k: 12 }` in
`HorsePhase13Selection.test.ts`, NLH value-action test in `JointLivePolicy.test.ts` uses a tournament decision.
Rule for the list: a variant is added when its own matrix shows a single-board cash loss, removed when a later matrix
shows it winning there. When the new matrices land, read every variant's `boards:1` cell; if any of PLO5, PLO6, FLO8,
FLH, Pineapple, Short Deck is negative there, add it to the list (this changes all P13 digests again, see section 2),
re-run, and do not select it until it wins.

The old Phase 13 PLO8 path (c84a2bcf qualification, declaration-completion-p13-2026-10-15.txt) is DEAD: #6973
changed every digest. Its H=16 window opened (read 16:00:11Z on 3002fe25) and was void at the 16:55 cutover.

## 4. Phase 13 Requalification On Source 818b10c1 (THE CRITICAL PATH)

Source: `818b10c16e962616008cc225a28a1cddba8cf6a0`. Contract digest (unchanged):
`0cd88d970c600fb64933337672af349e9d106402d4edfcc3510e1f26374741f8`. Policy digests (computed at 818b10c1 16:39Z and
again from release a2ccc04d's own tree at 21:18Z, identical):

| Variant    | Policy digest                                                    |
| ---------- | ---------------------------------------------------------------- |
| nlh        | abcfa99773326632f6f366f02cea1020a43b84103562af6664dcc6acf75812f4 |
| short_deck | e0236592c9823c58c42b6baf8d91f92fc262c3b9c27b24fa593417c4a7e305ef |
| flh        | 69458e2366cebc41f693715f6d75ec0c5b9fd7dba5570eb793a38b5ff7b7baea |
| pineapple  | 0bb928074a5666320465428005fad8204bc521e4f31d3c23ad70a0f962c03ab1 |
| plo4       | 3e821046225a0ecd99d62ca4cae1cd9225307447ea46e826d08f2e535c11fcc3 |
| plo5       | 7f51d3ff4357893801f0dbc0ab6fdcb74b50a0665992cc9fd730d3e233a330cf |
| plo6       | 4186e73000372cddb3a77fc7366b2aad77f95275c6581ff857909fc615419b52 |
| plo8       | 490031ed869bd065d3b14b63459f32c9cda0d3f9d738867ea96305f64f7195ec |
| flo8       | 6d73ac63c300b07e151dff3e5a80823b4e1d9c80207e0bc30a2cb37af9ae5c33 |

Digest script (Mac): `$W/p13-digests.mts` (copy into `<worktree>/server/zz-digests.mts`, `npx tsx zz-digests.mts`,
delete it). Results: `$W/p13-digests-818b10c.txt`, `$W/p13-digests-a2ccc04.txt`.

### 4.1 Strength Runs (Dispatched On 818b10c1)

| Run         | Workflow | Variant    | State 23:24Z                                    |
| ----------- | -------- | ---------- | ----------------------------------------------- |
| 38770647103 | P13      | nlh        | queued (106 jobs; 81 done 22:10Z)               |
| 38770650487 | P13      | plo4       | queued (154 jobs; about 100 done 22:10Z)        |
| 38770654073 | P13      | plo8       | queued (139 jobs; about 95 done 22:10Z)         |
| 38808839485 | P13      | plo5       | queued                                          |
| 38808842810 | P13      | plo6       | queued                                          |
| 38821822996 | P13      | flo8       | queued                                          |
| 38771868755 | P12      | flo8       | COMPLETED, assembled, NOT qualified (section 5) |
| 38808846451 | P12      | short_deck | queued                                          |
| 38821825625 | P12      | pineapple  | queued                                          |

NOT yet dispatched (dispatch when slots free; at most 3 or 4 of these runs at once, CI is saturated by all agents):

- `gh workflow run horse-phase13-strength-league.yml -R Smarter-Poker/Smarter-Poker-Club-Arena --ref main -f source_sha=818b10c16e962616008cc225a28a1cddba8cf6a0 -f variant=short_deck`
- same with `-f variant=flh`
- same with `-f variant=pineapple`
  "queued" at run level only means some jobs wait for runners; check jobs with
  `gh api repos/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/<id>/attempts/1/jobs?per_page=100&page=N`.
  Cancelled shards: `gh run rerun <id> --failed`; assemblers count the earliest complete attempt.

### 4.2 Assemble Each Finished Run

```
W=/Volumes/SmarterWork/agent-work/claude-takeover-20261014
mkdir -p $HOME/agent-work/runs-p13-<v>-818
gh run download <run> -R Smarter-Poker/Smarter-Poker-Club-Arena -D $HOME/agent-work/runs-p13-<v>-818
cd $W/src-818b10c/server     # clean detached worktree of 818b10c1; root node_modules installed 23:05Z (prettier present)
npx tsx scripts/phase13-strength-assemble.mjs --variant=<v> --runs=$HOME/agent-work/runs-p13-<v>-818 \
  --out=../docs/evidence/phase13/818b10c1/strength-2026-10-1X-<v>
```

The assembler writes the strength record and `phase13-qualification-<date>-<v>.json` beside it, refuses a dirty tree,
and refuses `prettier_unavailable`. MOVE each output out of `src-818b10c` (into the publishing branch) before the next
assembly, or the next one refuses the dirty tree. (`src-818b10c` is clean again: the P12 FLO8 output was moved into the
publishing branch of section 9.)
Read `verdict.qualified`, `verdict.reasons`, and every `boardCounts` cell (section 3 rule).

### 4.3 Completion Window

Declaration: `docs/evidence/phase13/declaration-completion-p13-single-board-2026-10-15.txt` (sha256
`f4d29d211c516398be2472bb84b7c967b35b96d1d4f93cd8d27f23024454d6ad`, written 16:40:27Z), amended by
`docs/evidence/phase13/declaration-completion-p13-single-board-2026-10-15-amended.txt` (sha256
`ea269341d831c886ed73b8dbee0ab440a7b38941c631cc5529d942bd3d6d2d49`, written 18:17Z). Rules:

- H = first whole UTC hour at or after 18:00Z 2026-10-15 whose serving release carries the section 4 digests,
  recomputed from that release's own tree before any journal read.
- Window [H:02:00.000Z, (H+1):50:00.000Z).
- Void only if the release changed: container StartedAt and `sp.release.sha` read before H:02 equal the reads after
  (H+1):50, `/health` releaseSha after (H+1):50 equals the label, and no auto-deploy run cut over a different release
  (trailing jobs of the serving release's own run do not void). If void, the next H after the void window.
- A variant with fewer than 127 eligible decisions on any street is not judged and carries to the next valid window;
  one with at least 127 on every street is recorded whatever it shows, never re-measured on the same release.
- Floor: Wilson lower bound z = 2.5758293035489 at least 0.95 on every street (and per admitted board count,
  `horsePhase13CompletionAdmittedBoardCounts`).

Window history (`$W/window-identity-reads-p13-818b10c1.txt`, committed copy in section 9):

- H=18: VOID (run 38772485733 of the serving release finished trailing jobs 18:12:48Z; strict original wording).
- H=20: VOID (container replaced 20:55:52Z by a2ccc04d).
- H=22: OPEN. read1 22:00:04Z: StartedAt `2026-10-15T20:55:52.63394784Z`, label and /health
  `a2ccc04d39bc15852d0047a32893371f3a0a6836`, no release run queued. Window
  [2026-10-15T22:02:00.000Z, 2026-10-15T23:50:00.000Z).

NEXT ACTION (time-critical): at or after 23:50:00Z, take read2:
`$W/read-identity-818.sh "read2 (after (H+1):50, H=22)"` (appends to `$W/window-identity-reads-p13-818b10c1.txt`),
and list auto-deploy runs between 22:00 and 23:50. If StartedAt 20:55:52.63394784Z and label/health a2ccc04d are
unchanged and no other release cut over: run stage 1 + stage 2 with
`$W/run-completion-p13-a2c.sh` (writes `$W/p13c-a2c/extract-<v>.ndjson`, `phase13-completion-<v>.json`, logs
`run.log`, `extract-<v>.err`, `record-<v>.err`; scripts taken from the clean release worktree `$W/src-a2ccc04`;
`VARIANTS="nlh plo4" $W/run-completion-p13-a2c.sh` runs a subset). Each ssh extract can exceed 60 s: run the script
double-forked. Then prettier each record and read the per-street Wilson bounds.
If read2 shows a change, record VOID H=22 and the next eligible H is 00:00Z on 2026-10-16 (window 00:02 to 01:50), etc.
If the 22:00 window is missed entirely and you arrive later, take read1 at the next whole hour between H:00 and H:02.
If any engine change touching the 36 policy files merges in between, the digests change: STOP, write a NEW
declaration for the new source before any window, and re-run strength on that source.

### 4.4 Select Every Variant That Passes Both

For each variant with a qualified strength verdict (and every `boards:N` cell it acts on positive) AND a completion
record that clears every street:

1. Publishing branch from `origin/main` (worktree under `$HOME/agent-work/`).
2. Copy qualification, strength directory and completion record into `docs/evidence/phase13/818b10c1/` AND
   byte-identical into `server/release-evidence/docs/evidence/phase13/818b10c1/`.
3. Set `PHASE13_PROTECTED_RELEASE_SELECTIONS.<v>` in `server/src/engine/HorsePhase13Authority.ts`:
   `schema 'horse-qualified-authority-selection-v1'`, `phase 'phase13'`, `variant`, `sourceSha
'818b10c16e962616008cc225a28a1cddba8cf6a0'`, `packVersion HORSE_PHASE13_PACK_VERSION`, `contractVersion
HORSE_PHASE13_CONTRACT_VERSION`, `contractDigest '0cd88d97...41f8'`, `domain jointStrengthDomain('<v>')`,
   `qualificationPath`/`qualificationSha256`, `completionPath`/`completionSha256`, `approvalGeneration 1`,
   `issuedAt` (after the window end), `expiresAt null`, `withdrawn null`. Pattern: the Phase 11 entries in
   `HorsePhase11Authority.ts` (line ~390).
4. Update the Phase 13 "all null" tests deliberately (`HorsePhase13Authority.test.ts` about lines 135 to 300; also any
   P13 expectations in `horseDecision/workerRuntime.test.ts`, `replay/exactReplay.test.ts`,
   `replay/qualifiedAuthority.test.ts`).
5. `cd server && TMPDIR=<tmp> npx vitest run src/engine src/services src/benchmark` (about 15,600 tests, 2 to 3 min)
   and `npx tsc --noEmit -p .`. Run the assemble tests from a COMMITTED tree (`phase13StrengthAssemble.test.ts` reports
   `policy_source_changed` on uncommitted policy edits).
6. Push, let the PR merge, wait for the engine release, verify live: run
   `phase13-completion-extract.py` for 5 to 15 minutes on the new release and count receipts
   (`body.decision.jointPolicy`: mode `candidate`, authority `usable`, approvalGeneration 1, applied).
   NOTE: the selection merge is itself an engine release; it does not change the 36 policy files, so digests stay.

## 5. Phase 12 (Short Deck, Pineapple, FLO8) Under Contract v2

- Contract v2 (`server/src/benchmark/RemainingVariantStrengthContract.ts`, `REMAINING_VARIANT_STRENGTH_V2_VARIANTS`,
  digest 6c50e717...) had NEVER been dispatched before today. FLH stays on frozen v1
  (`RemainingVariantStrengthContractV1.ts`, fafbba8d...).
- P12 FLO8 v2, run 38771868755 on 818b10c1, assembled 23:05Z: NOT QUALIFIED. Primary +1.06 [+0.72, +1.40] bb/100, no
  losing cell, but `cash:profile:p12c-flo8-6max-2dealt-100bb:interval_not_trusted` (+0.56 [+0.30, +0.82], Edgeworth
  0.00145 > 0.001) and `cash:position:big_blind:interval_not_trusted` (+0.05 [-0.02, +0.11], Edgeworth 0.00571).
  evidenceSha256 `ff09841bf477afbd7b3c156a4b3f8cd0da3960bab1426a0b4872b17c56d93513`. Files:
  `docs/evidence/phase12/818b10c1/strength-2026-10-15-flo8/`, `phase12-qualification-2026-10-15-flo8.json`
  (committed by section 9).
  Fix path: the big blind cell is a rare large change (BB defend `bigBlindDefendBelowCallBar 0.15` on the fixed-limit
  rules). Give FLO8 its own rule set without the BB defend (as round 4 capped Short Deck/Pineapple with
  `bigBlindDefendMaxDealt`), new pack version (e.g. `fixed-limit-omaha8-round4-v1`), then re-run. WARNING:
  `RemainingVariantPolicyPack.ts` is in the Phase 13 policy file list AND the Phase 12 digest inputs: editing it changes
  all nine Phase 13 digests and the live FLH Phase 12 selection's digest (FLH generation 3 would drop to shadow).
  Do it only AFTER the Phase 13 selections of round 4.4 are live, check the Phase 12 digest definition for FLH first,
  and plan a combined requalification (FLH + Phase 13) on the new source.
- P12 Short Deck (38808846451) and Pineapple (38821825625) v2 runs: assemble with
  `npx tsx scripts/phase12-strength-assemble.mjs --variant=<v> --runs=<dir> --out=../docs/evidence/phase12/818b10c1/strength-2026-10-1X-<v>`
  in `$W/src-818b10c/server`. If qualified: Phase 12 completion needs its OWN predeclared window (stage 1
  `server/scripts/phase12-completion-extract.py`, stage 2 `src/scripts/phase12CompletionRecord.ts`; template
  `$W/run-completion.sh`), then `PHASE12_PROTECTED_RELEASE_SELECTIONS.<v>` with the Phase 12 contract v2 digest.

## 6. Launch-Readiness Register (Everything Left)

1. Phase 13 NLH, PLO4, PLO8, PLO5, PLO6, FLO8: strength running; completion window H=22 open; select each that passes
   (section 4). Highest priority.
2. Phase 13 Short Deck, FLH, Pineapple: dispatch strength (section 4.1), then completion + selection.
3. Single-board list review once every P13 matrix is in (section 3 rule).
4. Phase 12 FLO8: wins but fails the trust check; pack revision + re-run (section 5 warning).
5. Phase 12 Short Deck, Pineapple: v2 runs running; assemble, then completion + selection.
6. Tournaments: Phase 8 selection null. Every contract marks tournament objectives "unavailable dependency" (no
   whole-tournament outcome model, no qualified tournament reference population, no thresholds). All promoted packs are
   cash only. Phase 7 owns tournament utility. Needs a tournament outcome model and reference population before any
   tournament selection; not started.
7. V31 solver (`docs/HANDOFF-2026-10-05-v31-solver-commissioning-PROMPT.md`): needs Dan's licensed PioSOLVER Windows
   hosts M1 (train) and M2 (holdout) powered on and linked (last liveness 2026-10-07, manifest
   relative-v2-pilot-20261007-r1, solver 3.8.0); `gto_v31_datasets` rows stuck 'building'; engine `solverStores
postflopV31 = 0`. Never put a Supabase service key on those hosts. Later strength enhancement, not a baseline need.
8. Human-population winning proof: after launch (Dan).
9. Decision workers: DONE (3 workers on a2ccc04d). Keep an eye on `/health.liveHorseDecision.journalCapacityUnreadable`;
   if it ever shows a reason, fix that cause.
10. CI capacity: max-parallel already set; the real constraint is org-wide runner saturation (76 queued runs seen).

## 7. Known Pitfalls

- Two green PRs merged by autopilot can break main together; run combined tests for overlapping horse PRs.
- A selection flipping null/non-null flips tests in the HorsePhase1x authority tests, `workerRuntime.test.ts`,
  `replay/exactReplay.test.ts`, `replay/qualifiedAuthority.test.ts`.
- Assemblers refuse a dirty measured worktree; move outputs out after each assembly.
- `gh api .../jobs` pages 2+ often 502 or hang: use `attempts/1/jobs?per_page=100&page=N` and short timeouts.
- The Mac lost DNS for a few minutes at 18:00Z (curl and gh failed); the ssh identity read still worked. Record any
  such gap honestly in the identity reads file.
- A release run finishes its trailing jobs 20 to 35 minutes after cutover; the amended declaration handles that.
- Bridge calls over about 60 s are cut; long work must be double-forked.

## 8. Files In The Takeover Folder (`/Volumes/SmarterWork/agent-work/claude-takeover-20261014/`)

- Publishing worktree of this handoff: `$HOME/agent-work/ho2` (main disk).
- Worktrees: `src-818b10c` (clean detached 818b10c1, root node_modules installed, server node_modules symlinked to
  `src-3002fe2/server/node_modules`), `src-a2ccc04` (detached a2ccc04d,
  for stage 2 of H=22), `src-3002fe2` (server node_modules only), `src-c84a2bc` (main checkout used to add worktrees),
  `p13-decl` (branch `claude/horse-p13-declaration-amendment-20261015`, merged as #6999), older ones from round 1
  (`src-c92768c`, `p11-select`, `p11b-select`, `flh-select`, `plo4-select`, `p13-evidence`, `lane-fix`, `p13-sb`,
  `cap-reason`, `src-38e91da`), all merged.
- Scripts: `read-identity-818.sh` (identity read to `window-identity-reads-p13-818b10c1.txt`),
  `run-completion-p13-a2c.sh` (stage 1 + 2 for H=22, release a2ccc04d), `run-completion.sh` (round 1 template),
  `p13-digests.mts`, `p13-policy-files.txt` (36 files, server-relative).
- Data: `p13-digests-818b10c.txt`, `p13-digests-a2ccc04.txt`, `window-identity-reads-p13-818b10c1.txt`,
  `window-identity-reads-p13-H16.txt`, `runs-p12-flo8-818/` (216 artifacts), `assemble-p12-flo8-818.log`, push logs.

## 9. Published In The Same PR As This File

- `docs/evidence/phase12/818b10c1/strength-2026-10-15-flo8/` and `phase12-qualification-2026-10-15-flo8.json`
  (not qualified; evidence only).
- `docs/evidence/phase13/window-identity-reads-p13-818b10c1-2026-10-15.txt` updated through the H=22 read1.
- This handoff.
