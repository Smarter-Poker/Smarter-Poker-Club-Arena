# HANDOFF PROMPT: Club Arena live-table launch bugs (2026-10-04 to 2026-10-05)

Paste this whole document as the first message of a new chat. Everything you
need is here. Do not ask the owner what was done; it is below, with the
command that proves each claim.

State verified 2026-10-05 18:15Z unless a line says otherwise.

---

## Part 0. Who you are and what you are picking up

You are an engineering agent on Smarter.Poker's Club Arena. It is a Vite +
React 19 + TypeScript SPA plus a server-authoritative poker engine (`server/`,
running on Hetzner), with Supabase as the database. The repo is
`~/Documents/club-arena` on the owner's Mac Studio. Many other AI agents
commit to the same repo in parallel.

The owner (Dan) reported ten mobile live-table bugs before launch. Over two
days, a previous agent:

- shipped five PRs: #6064, #6092, #6105 and #6137 are merged and live;
- has #6159 OPEN with auto-merge armed and CI running. Your first job is to
  see #6159 through to live.

What went wrong in the prior session, so you do not repeat it:

1. Its first fix for "no cards during the maintenance break" keyed on
   `currentPlayerSeat === 0`. That value is also 0 between every two actions,
   so live cards were hidden at :55. A review caught it and #6105 fixed it.
   Lesson: never infer "hand over" from a turn pointer.
2. The first hand-back left item 7 (the :11 break) unanswered. The owner
   insisted, and #6092 removed the break.
3. #6159 was blocked twice by `Server Engine shard 3/4` failing on a
   timing-dependent horse-brain test that #6159 does not touch. It was re-run
   once, then main was merged into the branch at about 18:10Z. See Part 5.

## Part 1. STOP CONDITIONS. Read before any work.

The owner's standing instructions, in his words:

> "DO NOT DO ANY UN NECESSARY TESTS, OR WORK OUTSIDE OF THIS SCOPE. FINISH ANY
> AND ALL TASKS USING THE FASTEST, MOST EFFICiENT ROUTE."

> "before you CLAIM SUCCESS , you need to do a deep dive and verify that every
> thing you've built in the previous phase is 100% fully built, coded, wired in
> and tested ... Make sure that everything has been fully pushed and published
> before CALLING THIS COMPLETED"

His saved preferences (binding):

- Fix at the root cause and harden against regression. Never add a cron,
  watcher, reconciler or repair loop in place of a fix.
- Pushed, tested, merged, published and verified-live are SEPARATE states.
  Report them separately. Never say "done" on a merge tick.
- You own push, merge and publish. The owner never does those steps. Carry
  every delivery through to live yourself.
- No frequent progress updates. Work in long stretches.
- You may run parallel subagents.

What you must NOT do:

- Do NOT run git inside the `mcp__remote-devices__device_bash` Linux mount. It
  strands `.git/index.lock`. Run git only through the Mac host shell (Part 2).
- Do NOT read or print `.env` values or any secret.
- Do NOT query production Supabase. A production read was denied by the
  auto-mode classifier in the prior session. Do not try another route around
  it.
- Do NOT "fix" `server/src/engine/remainingVariants/RemainingVariantNetAction.test.ts`.
  It belongs to the Horse Brain programme (other agents, PRs #6151 and #6156),
  so it is out of scope.
- Do NOT change horse fallback policy (Part 6, DECLINED).
- Do NOT add an auto table switch anywhere. Repo law: the app never moves the
  player's active tab on its own.
- Do NOT write em dashes in player-visible text. Popups are Title Case. No
  emoji in source.

## Part 2. Environment bootstrap. Run these first.

You will have two shells. Use them like this:

- `mcp__remote-devices__counselors__host_terminal` is the REAL Mac shell. Use
  it for git, gh, node, npm and vitest. Every call dies at 60 s.
- `mcp__remote-devices__device_bash` is a Linux VM with the folders mounted
  under `$HOME/mnt/...`. Use it for reading and editing only, never git.

Prefix every host command with:

```
export PATH=/opt/homebrew/bin:$PATH
```

To run anything longer than 60 s, background it, then poll it in later calls:

```
(nohup <cmd> > /tmp/x.log 2>&1; echo EXIT $? >> /tmp/x.log) >/dev/null 2>&1 &
sleep 50; tail -5 /tmp/x.log
```

macOS `sed -i` needs `''` and is BSD sed. Do multi-line edits with
`python3 - <<'EOF' ... EOF` and assert `s.count(old)==1` before every replace.

Worktrees: never edit `~/Documents/club-arena` itself. Create one:

```
cd ~/Documents/club-arena && bash scripts/agent-workspace.sh <agent-name> <branch-slug> --print-path
```

Run it under nohup; it takes about 2 minutes. It creates
`/Volumes/SmarterWork/agent-work/club-arena/<agent-name>` on branch
`agent/<agent-name>/<branch-slug>`. Then run `npm ci --no-audit --no-fund`
there, also under nohup.

Pushing: the pre-push hook runs the full client suite and flakes under host
load. Use this form; it has passed every time:

```
VITEST_MAX_FORKS=4 VITEST_MAX_THREADS=4 VITEST_MIN_THREADS=1 VITEST_MIN_FORKS=1 nohup git push -u origin HEAD > /tmp/p.log 2>&1 &
```

`gh pr create --body "$(cat <<'EOF' ...)"` breaks on apostrophes in this
shell. Write the body to a file and pass `--body-file`.

Commit trailer, required:

```
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012Gm3jZFEX28W2dfJapGESt
```

PR bodies end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`
followed by the session URL.

## Part 3. How the thing actually works

Delivery pipeline:

1. You push a branch and open a PR. Agent Autopilot arms auto-merge and the
   repo squash-merges when the required checks pass.
2. The client is published by `publish-club-arena.yml`, about 10 minutes
   after the merge. Proof of live is the `ca_sha` in BOTH:
   - `https://ca-static.smarter.poker/build-info.json`
   - `https://smarter.poker/hub/club-arena/build-info.json`
3. The engine is staged by `stage-engine-release.yml`, then
   `auto-deploy-hetzner.yml`. It activates ONLY at the :55 hourly maintenance
   break. Proof of live is `releaseSha` from
   `curl -s https://engine.smarter.poker/health`.
4. A commit is live when `git merge-base --is-ancestor <commit> <live sha>`
   succeeds. The live sha is often a LATER main commit, and that is fine.

The ten features and where they live:

| # | Owner's bug | Fix lives in |
|---|---|---|
| 1 | Club lobby card images broken at first | `src/components/.../CarouselSection.tsx` (static imports), `ClubCardPanel.css` (dark image well) |
| 2 | Tab pill said "MTT 200/400" | `TableTabBar.tsx`, `src/lib/tournamentTabLabel.ts` (`readTournamentBuyIns`), `src/utils/gameCode.ts`, `tournamentBuyIn` on `TableInstance` in `src/pages/MultiTablePage.tsx` |
| 3 | Tournament box over the table | `src/components/tournament/TournamentHUD.tsx/.css`, a dock under the action bar. `src/lib/tournamentDockStore.ts` holds the collapse state. The LOBBY corner button is `.tournament-lobby-corner-btn` |
| 4 | Countdown ring must take 15 s | `src/components/table/SeatSlot.tsx/.css`. The turn anchor is frozen once per turn (the root cause of the 2x speed was the delay being rewritten every second) |
| 5 | Remove x2/x3 chip multipliers | `ChipPhysics`, `PotDisplay`, `chipDenominations` |
| 6 | ALL IN facing a bet failed silently | `server/src/engine/HandController.ts` `performAction` degrades an illegal shove to call or check. The horse path is in `ServerTableEngineTurns.ts` |
| 7 | Cards during the break and after the hand; the :11 break | `finishedHand`, `tableHandIsOver`, `breakHidesCards`, `feltShowsNoHand` in `src/pages/TablePage.tsx`. The :11 break was the off-cycle "Deployment Recovery" window: `server/scripts/engine-release-seal.py` `cmd_reserve_recovery_window` and `engine-release-transaction.sh` |
| 8 | "+" on an MTT offered cash | `handleAddTable` in `MultiTablePage.tsx`, `src/lib/quickJoinTournaments.ts`, `quickJoinIsTournament` in `src/lib/quickJoinRanking.ts`, `initialGameType` in `ClubHomePage.tsx` |
| 9 | Win % on top but never over cards | `src/components/table/EquityBadgeLayer.tsx`, `src/lib/equityBadgePlacement.ts` |
| 10 | "Reconnecting Your Seat" on a table-break move | `src/components/table/DisconnectToast.tsx` (moved line), `announceTournamentMove` and `claimMoveAnnouncement` in `MultiTablePage.tsx`, `TableConnectionBanner.css` (no clipping) |

## Part 4. Complete state inventory (verified 2026-10-05 18:15Z)

| PR | Commit on main | What | Client live | Engine live |
|---|---|---|---|---|
| #6064 | `ed794ed667` | The ten fixes | yes (`7acd3ec2b5`) | yes (`5815ef3508`) |
| #6092 | `35ba6fecfd` | :11 break removed; recovery window only for urgent, engine-degraded or deadline | yes | yes |
| #6105 | `65f62efd28` | Review follow-ups (cards hidden in a live hand fixed, dock store, equity observers, horse whole-stack guard, release-script early return) | yes | yes |
| #6137 | `4abdb9be38` | Residuals: PFR not counted for an ALL IN that executes as a call; lobby remount (`lobbyLandedList`); `handleAddTable` run token; spin read timed; finished hand drops the `--showing` lift | yes | client-only |
| #6159 | OPEN, head `ab1cbaec6b` | Polish (Part 5) | NO | NO |

Changelogs, one file per session:

- `docs/changelog/2026-10-04-mobile-live-table-launch-bugs.md`
- `docs/changelog/2026-10-04-one-scheduled-break-an-hour.md`
- `docs/changelog/2026-10-04-live-table-launch-bugs-review-followups.md`
- `docs/changelog/2026-10-05-live-table-review-residuals.md`
- `docs/changelog/2026-10-05-live-table-polish.md` (in #6159)

There are no migrations in this programme. The off-cycle break is gone:
every auto-deploy since 2026-10-05 00:00Z sealed inside the :55 break.

## Part 5. The task that blocks everything else: land #6159

#6159 is `fix(live-table): report discarded Quick Join errors, readable dock,
slow-socket move line`, on branch `agent/claude-livebugs-1005e/fix/live-table-polish`.
The worktree is `/Volumes/SmarterWork/agent-work/club-arena/claude-livebugs-1005e`.

Already done:

- The code. Locally tsc was clean, 23 affected test files passed (457 tests),
  and `tests/operations/engine-release-recovery-window.py` printed OK. Pushed.
- Main merged into the branch as `ab1cbaec6b`, to pick up the reworked
  horse-brain `remainingVariants` code. CI restarted at about 18:10Z.

NOT done: merge, publish and live verification.

Contents of #6159:

- **Quick Join cash read.** A failed read is thrown, reported, and takes the
  lobby exit. Before, `{ data: null, error }` read as "No Open Seats Right
  Now". The other reads on that path report too: club lookup, active row, and
  the seat-move read and its catch. `readTournamentBuyIns` throws instead of
  returning an empty map.
- **Move paths.** A shared `tabIsTournament()` helper, the same rule the tab
  bar uses. Both move paths fall back to "A New Table".
- **`/tournaments` backstop.** Now calls `openLobbyTabOn('MTT')`.
- **Tournament dock.** It is now `role="group"` with a real `<button>` toggle
  line; before, `role="button"` hid its figures from screen readers. Focus
  rings added. The collapse choice syncs across browser tabs via a `storage`
  listener.
- **`DisconnectToast` moved line.** The 10 s window starts when the socket
  connects, if that is within `MOVED_HERE_MAX_WAIT_MS` (60 s) of the move.
- **Seal.** It will not replay a recovery reservation whose recorded cause is
  routine.
- **Tests.** New `tests/unit/liveTablePolish.test.tsx`. Pins updated in
  `a-moved-seat-is-not-a-reconnecting-seat.law`,
  `the-tournament-box-is-under-the-action-bar.law`, `multiTableFollowups`
  and `engine-release-seal.law`.

Do this:

```
cd ~/Documents/club-arena && export PATH=/opt/homebrew/bin:$PATH
gh pr view 6159 --json state,mergeCommit --jq '{state,sha:.mergeCommit.oid}'
gh pr checks 6159 --json name,state --jq '.[] | "\(.state) \(.name)"' | grep -v SUCCESS
```

Then branch on what you see:

- **MERGED.** Wait for publish, then run the Part 9 live checks against the
  merge commit. Expect a client-only release; the seal script ships with the
  next engine release and needs no live check.
- **Only failure is `Installed and merged migrations agree`.** That check is
  red from other tasks' migrations and is not blocking. Wait.
- **`Server Engine shard 3/4` fails again on `RemainingVariantNetAction.test.ts`
  > "P12.1 ... reports a result or one of a CLOSED set of named refusals"
  ("expected undefined to be truthy").** It is a wall-clock budget test that
  starves on loaded CI runners. It failed release run 37321047049, then passed
  on the next run with the same code. #6159 changes nothing under
  `server/src`; prove that with
  `git diff --stat origin/main...origin/agent/claude-livebugs-1005e/fix/live-table-polish -- server/src`,
  which must print nothing.
  1. Find the run with `gh pr checks 6159 --json name,link`. Wait until the
     whole run is `completed` (`gh run view <id> --json status`). The
     re-run is refused while any job is still running.
  2. Then run `gh run rerun <id> --failed`.
  3. If it fails a third time, check whether main fails it too:
     `gh run list --workflow "CI — Build & Type Safety" --branch main -L 5`.
     Report to the owner that a Horse Brain test is blocking an unrelated PR.
     Do not edit the test.
- **Merge conflict.** In the worktree run `git fetch origin main &&
  git merge origin/main`. Resolve, run the Part 9 focused tests, then push
  with the Part 2 form.

When it is live, remove the worktree and the temp files:

```
git -C ~/Documents/club-arena worktree remove /Volumes/SmarterWork/agent-work/club-arena/claude-livebugs-1005e
rm -f /tmp/lb1005e-*
```

Then send the owner the final report. List merged, published-client and
engine status separately.

## Part 6. Backlog

HIGH: none in scope once #6159 is live. The 2026-10-05 line-by-line review
(three reviewers: table page, lobby and Quick Join, engine and release) found
no confirmed defects in the table page or the engine. Every defect it found
is in #6159.

LOW, optional, only if the owner asks:

- **`ClubCardPanel.tsx` card image.** Add an inline
  `style={{width:'100%',height:'100%',objectFit:'cover'}}`, so the square
  holds even if the CSS chunk is late. It was skipped because the root cause
  (lazy CSS) was already fixed by the static imports.
- **`RemainingVariantNetAction.test.ts` flakiness.** Report it to the Horse
  Brain owner; it is not yours.

DECLINED, do not build. A future agent "fixing" either of these is making a
mistake:

- **Horse falls back to call when its raise is refused**
  (`ServerTableEngineTurns.ts` around 4014, check then fold). A human whose
  raise is refused gets no automatic call. Repo law: horses are treated
  exactly like players.
- **Persistent screen-reader live region in `DisconnectToast`.** It would
  duplicate the text node. The law test
  `a-moved-seat-is-not-a-reconnecting-seat.law.test.tsx` pins the exact
  `textContent`. The visible pills already carry `role="status"`.

Done differently than first specified:

- **The :11 break was narrowed, not deleted outright.** The recovery window
  still exists for `urgent`, `engine-degraded` and `deadline`. Routine causes
  (a failed release, a missed certificate) now wait for :55. This is
  documented in CLAUDE.md section 13.
- **An ALL IN press facing a bet the seat cannot raise.** It executes as a
  call, or as a check when nothing is owed. The menu still offers `all_in`
  only as a real shove.

## Part 7. Every defect found, and its lesson

1. **Live cards hidden at :55.** `breakHidesCards` keyed on
   `currentPlayerSeat === 0`. The fix requires pot 0, an empty board and no
   winner (`pot` includes blinds and antes from the deal). Lesson: "no one is
   to act" is not "no hand".
2. **Countdown ring ran at 2x.** The delay was recomputed every render from a
   moving now. The fix freezes the anchor per turn key. Lesson: an animation
   whose duration is derived from now must be frozen once.
3. **ALL IN counted as a preflop raise when executed as a call.**
   `applyOptimisticHeroAction` paints `lastActions[hero]='all_in'`, and the
   lastActions effect counted anything that was not a call. Fixes:
   - the effect counts bet and raise only;
   - the hero's PLAYER_ACTION echo counts a shove only if its amount exceeds
     every other seat's `lastBetAmounts`.

   The engine echoes `all_in` even for a short stack's call. Lesson:
   optimistic labels must never feed statistics.
4. **Lobby stayed on the tournament list for a cash "+".** OPEN_LOBBY_TAB
   reuse only focused the tab, and a mounted page keeps its own state. Fix:
   the `lobbyLandedList` mark plus a nonce bump to remount. Lesson: clearing a
   prop does not reset a mounted component's state.
5. **Late Quick Join exits after the sheet closed.** There was no run token.
   Fix: `quickJoinRunRef` plus `stale()` after every await, retired by
   `closeQuickJoin`.
6. **"No Open Seats Right Now" on a failed read.** Supabase returns
   `{error}`; it does not throw. Lesson: read `error` on every query. The repo
   ratchet `tests/unit/discardedErrorReadRatchet.test.ts` enforces this.

The shape these share: a value standing in for a different fact (a turn
pointer for "hand over", an optimistic label for an executed action, empty
data for "no rows", a focused tab for "reset view"). Check what a value
PROVES, not what it usually means.

## Part 8. Traps and instruments that lie

- **A green merge tick is not live.** Check both build-info endpoints and the
  engine health `releaseSha` with `git merge-base --is-ancestor`.
- **Engine merges are not live until the next :55 break.** An engine commit
  merged at :56 waits about an hour.
- **`Installed and merged migrations agree` is red from other agents'
  migrations.** It does not block. Do not chase it.
- **The pre-push hook fails under load.** That is a host problem, not your
  code. Use the reduced-worker push form.
- **`gh run rerun --failed` refuses while any job in the run is still
  running.** Wait for `status == completed`.
- **`agent-workspace.sh` may print "unable to open loose object ...
  Interrupted system call".** It retries itself. Confirm with
  `git status --short | wc -l`, which must print 0.
- **A stale `.git/index.lock`.** Remove it only after `pgrep -fl git` shows
  no git process.
- **Source-pin tests (`toContain` on source text) break on harmless
  reformatting.** When you restructure code, grep `tests/` for the old string
  first.

## Part 9. Verification commands

Did the work land? Each line must print the "yes" text:

```
cd ~/Documents/club-arena && git fetch -q origin main
for c in ed794ed667 35ba6fecfd 65f62efd28 4abdb9be38; do git merge-base --is-ancestor $c origin/main && echo "$c on main"; done
```

Is it live? Read the two `ca_sha` values and the engine `releaseSha`, then run
the ancestor check for each commit:

```
curl -s https://ca-static.smarter.poker/build-info.json
curl -s https://smarter.poker/hub/club-arena/build-info.json
curl -s https://engine.smarter.poker/health | python3 -c 'import sys,json;print(json.load(sys.stdin).get("releaseSha"))'
git merge-base --is-ancestor <commit> <ca_sha> && echo client-live
git merge-base --is-ancestor <commit> <releaseSha> && echo engine-live
```

Both `ca_sha` values must match. If they differ, a publish is in flight;
wait 10 minutes.

Focused test gate for any change in this scope, run in the worktree:

```
npx tsc -p tsconfig.app.json --noEmit
npx vitest run tests/unit/liveTablePolish.test.tsx tests/the-tournament-box-is-under-the-action-bar.law.test.ts tests/unit/tournamentHudPolling.test.tsx tests/a-moved-seat-is-not-a-reconnecting-seat.law.test.tsx tests/a-tournament-tab-says-its-buy-in.law.test.tsx tests/unit/multiTableFollowups.test.ts tests/unit/quickJoinRunAndLobbyRemount.test.ts tests/unit/allInPressIsNotAllInMode.test.ts tests/action-bar-never-leaves.law.test.ts tests/hub-tab-is-a-browser-tab.law.test.ts tests/a-tournament-offers-more-tournaments.law.test.ts tests/unit/discardedErrorReadRatchet.test.ts tests/unit/noFixedSizeSourceWindows.test.ts tests/engine-release-seal.law.test.ts tests/unit/seatAndEquityFollowups.test.tsx tests/must-move-lobby.test.tsx
python3 tests/operations/engine-release-recovery-window.py
```

Healthy: tsc prints nothing, every test file passes (about 460 tests), and
the Python script prints OK. Run vitest under nohup and poll it.

## Part 10. File map (all live unless noted)

| Path | Role |
|---|---|
| `src/pages/TablePage.tsx` | Felt. `feltShowsNoHand`, `breakHidesCards`, PFR/VPIP effects, the PLAYER_ACTION echo |
| `src/pages/MultiTablePage.tsx` | Tabs. `handleAddTable` (Quick Join), OPEN_LOBBY_TAB, the move announcer, `tabIsTournament` (in #6159) |
| `src/pages/ClubHomePage.tsx` | Lobby. `initialGameType` landing, `onInitialGameTypeConsumed` |
| `src/components/table/SeatSlot.tsx/.css` | 15 s ring, frozen anchor, `@supports` conic gate |
| `src/components/table/EquityBadgeLayer.tsx` | Win % layer, placed around cards |
| `src/components/tournament/TournamentHUD.tsx/.css` | Dock and LOBBY corner button |
| `src/lib/tournamentDockStore.ts` | Shared collapse state (`useSyncExternalStore`) |
| `src/components/table/DisconnectToast.tsx` | "You've Been Moved To", reconnect lines |
| `src/lib/quickJoinTournaments.ts`, `quickJoinRanking.ts`, `quickJoinSpins.ts` | Quick Join data |
| `src/lib/tournamentTabLabel.ts` | Tab pill buy-in |
| `server/src/engine/HandController.ts` | ALL IN degrades to call or check |
| `server/src/engine/ServerTableEngineTurns.ts` | Horse action path |
| `server/scripts/engine-release-seal.py`, `engine-release-transaction.sh` | Off-cycle recovery window, emergency causes only |
| `CLAUDE.md` section 13 | Release and break doctrine |

## Part 11. How to behave on this work

- **Read the code path before believing a test.** Most tests here pin source
  text.
- **Fix the root cause.** Never a watcher or a retry loop.
- **Write one changelog file per session** under `docs/changelog/`.
- **Every new `*.law.test.*` needs a `docs/laws.d/*.md` registry entry.**
- **Never slice source by character counts in tests.** Use
  `tests/helpers/sourceWindow.ts` (`sliceBetween`).
- **Report merged, published and live separately, each with its sha.**
- **Stay inside the ten features.** The owner forbids out-of-scope work.

## Part 12. Opening moves, in order

1. Run the Part 2 PATH export. Run `git -C ~/Documents/club-arena fetch -q
   origin main`.
2. Check the #6159 state and checks (Part 5 commands).
3. Act on the Part 5 branch that matches.
4. Once it is merged, poll both build-info endpoints until `ca_sha` contains
   the merge commit.
5. Remove the `claude-livebugs-1005e` worktree and `/tmp/lb1005e-*`.
6. Report to the owner. Give merged, published and live separately, and name
   anything still open.
7. While blocked on CI, do nothing else in this repo. There is no other
   in-scope work.

Last line, and the hardest rule: do not edit
`RemainingVariantNetAction.test.ts` or any horse policy to get #6159 green. It
is not your code, and a green tick bought that way is a lie.
