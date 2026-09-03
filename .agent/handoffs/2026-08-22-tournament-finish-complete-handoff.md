# Handoff — the tournament finish path, end to end, and what is still open

**Date:** 2026-08-22 · **Repo:** Smarter-Poker-Club-Arena
**Author:** Claude (Cowork session)
**Supersedes:** `.agent/handoffs/2026-08-22-tournament-winner-exit.md` — that file
is on main and still accurate as far as it goes, but it was written between the
two PRs and does not know about the second one. Where they disagree, this wins.
**Also read:** `.agent/handoffs/2026-08-22-union-reserve-and-shipping-from-cowork.md`
for the union reserve wallet work and the Supabase manifest gate (§3 there is
still the best description of that gate and is unchanged).

---

## 0. THE THIRTY-SECOND VERSION

Item 6.1 of the union-reserve handoff — "tournament completion card at the end of
a spin, for ALL finishers" — is **done, merged and serving in production.** It
took three PRs, because the first one fixed only half of it and the audit of that
fix found six more defects in the same twenty lines.

Everything below §4 is what is still open. Nothing in §1–§3 needs redoing.

---

## 1. HOW YOU SHIP NOW — THIS CHANGED TODAY, READ IT FIRST

**Read `AGENT-PLAYBOOK.md` at the repo root before anything else.** It is
byte-identical in all seven repos and `estate-integrity` checks hourly that it
still is. `.agents/rules/00-agent-playbook.md` is the always-on summary; the
playbook is the source. Both landed on 2026-08-22 (#253, #259) and both are
newer than any handoff you will find, including this one.

The sequence, every time:

```bash
eval "$(bash scripts/agent-workspace.sh <your-agent-name> fix/<short-slug>)"
# ...do the work...
git add -A && git commit -m "fix(scope): what changed"
git push -u origin HEAD && gh pr create --fill
# STOP. You are done.
```

**Agent Autopilot enables squash auto-merge server-side within seconds and
GitHub merges when the required checks go green. YOU NEVER MERGE.** If a PR is
not merging, read the failing check and fix the code. Never reach for a flag
that makes the check stop applying.

**Step 1 is the one that matters most.** Three to five agents work here at once
and a working tree has one HEAD, one index, one set of uncommitted files.
`.husky/pre-commit` now REFUSES a commit made in the shared clone and prints the
exact command above. Do not work around it.

**CLI and API only. Never the browser UI.** `git`, `gh`, the Supabase MCP, HTTP.
Every guard in this estate reasons about repository state through the API; an
action taken outside it is invisible to all of them. Reading a rendered page to
check production looks right is fine. Performing a git, deploy or database
operation there is not.

The GitHub UI shows things that are **not signals** — the "had recent pushes,
Compare & pull request" banner persists for about a day after a branch has
merged or been deleted. Ask the API: `gh pr list --state all --head <branch>`.

**Never:** `gh pr merge --admin` (bypasses checks; red code reached main four
times) · `gh pr merge --merge` / `--rebase` (disabled; they fail SILENTLY while
you report success) · `git push` or `--force` to main (a force-push once dropped
four live commits) · `git pull --rebase origin main` (strands the clone; use
`scripts/git-unstick.sh`) · `--no-verify` · `--ours`/`--theirs` on a whole file
(that is how a leaderboard RPC vanished while its signature survived) · any
polling or wait-and-merge script (Autopilot does this server-side) · writing a
migration and not applying it (apply with the Supabase MCP `apply_migration`, or
it fails 42703 into a catch block and NOTHING goes red) · `vercel deploy` or any
deploy hook · asking a human to push, merge, deploy or approve anything.

**Credentials — you are not missing them, you are looking in the wrong place.**
No secret value is written in any file in these repos; several are public.
Merges and publishing use the GitHub App "Smarter-Poker-Autopilot", id 4680372,
via `vars.AUTOPILOT_APP_ID` + `secrets.AUTOPILOT_APP_PRIVATE_KEY` in all seven
repos; workflows mint a fresh token per run and it cannot expire. `GH_PAT` is a
legacy fallback expiring 2026-11-19. `GITHUB_TOKEN` is for issue writes only —
**never merge with it**, because a merge made with it does not trigger
downstream workflows, so the commit lands and never publishes. Supabase /
Vercel / Hetzner live in repo secrets in CI and `.env.local` locally.
smarter.poker is `kuklfnapbkmacvwxktbh`; PepNationLab is `ydsaqnnuwyvtyxgvrnys`;
never cross them. If a credential is genuinely dead, the workflow that needs it
says so by name and opens an issue. Do not guess and do not ask for a secret.

**If you think you have lost work, you almost certainly have not:**

```bash
bash scripts/agent-trees-audit.sh            # what is at risk right now
bash scripts/agent-trees-snapshot.sh --list  # what was captured
git checkout -b rescue refs/wip/<ref>        # recover it
```

`.husky/reference-transaction` refuses any ref update that would orphan local
commits and saves them to `refs/wip/orphan-guard/` first. A snapshot of every
working tree runs every ten minutes.

**Before you say it is done, ask production — not the exit code:**

```bash
curl -s https://smarter.poker/hub/club-arena/build-info.json   # Club Arena
curl -s https://smarter.poker/api/health                        # World Hub
```

Compare `ca_sha` to `origin/main`. A green tick answers "did it merge". Only
production answers "did it ship", and every failure this estate has had hid
behind something that reported success.

### 1.1 Practical notes from actually doing this today

- **`scripts/agent-workspace.sh` may not exist in the shared clone** — that
  clone runs dozens of commits behind. Extract it from main first:
  `git show origin/main:scripts/agent-workspace.sh > /tmp/aw.sh && bash /tmp/aw.sh <agent> fix/<slug> --print-path`
- **Symlinking the shared clone's `node_modules` lies to `tsc` and breaks
  `vite build`.** That clone is stale, so packages `package.json` declares are
  physically absent — `react-virtuoso` produced five phantom errors in
  `LeaderboardPage.tsx` and a hard Rollup failure. If you need a real build or a
  trustworthy typecheck, run `npm ci` **in your own worktree** first. It takes
  about a minute and removes an entire class of false alarm.
- **The Cowork `host_terminal` shell kills its process group when the call
  ends,** and any call sleeping longer than ~140s times out. Long jobs must be
  written to a script file and launched with `nohup /tmp/x.sh >/dev/null 2>&1 &`,
  writing results to a log you poll in separate short calls. A bare `&` inside a
  normal call does not survive.
- **`Build for World Hub Sync` runs `cancel-in-progress`.** With this many
  agents your own sync run will very often show `cancelled`, and that is normal,
  not a failure — it publishes from `main`, so your work goes out with whichever
  run survives. Verify with `build-info.json`, never with your own run's status.
- **The Read/Write/Edit file tools could not reach
  `~/Documents/.agent-trees/...`** in this session ("outside this session's
  connected folders"). All edits were made through `host_terminal` with
  `python3` heredocs doing exact-anchor replacements with `assert count == 1`.
  That worked well and is safer than `sed`.

---

## 2. WHAT WAS BROKEN, AND WHAT WAS DONE ABOUT IT

Three PRs, all merged, all serving. Full narrative in `MIGRATION-CHANGELOG.md`
under the two 2026-08-22 tournament entries.

### PR #242 — `5056e6438` — the winner was never told the tournament had ended

**Dan, 2026-08-20:** _"at the end of the tournament when you lose, you need to be
auto removed from the table, placed inside the lobby and your tournament result
card shown … winners should be auto removed at the end as well."_

Only the losing half of that sentence had ever worked.

`eliminatePlayer` broadcasts `player_eliminated`; TablePage hears it, plays the
beat and moves that player to the lobby with a ranking card. Places 2..N were
fine. **`finishTournament` broadcast nothing at all** — it paid the winner,
stamped `status='winner', position=1`, released the seats, closed the tables and
returned, in silence. The champion sat at a table that had just been closed
underneath them, with no card and no way out but the browser.

**Why nothing caught it.** TablePage had carried the winner branch
(`position === 1` → celebration overlay → lobby) since the day the feature
shipped. It was unreachable **by construction**, and no type checker could ever
say so: the only event that reaches it is `player_eliminated`, and
`eliminatePlayer` is never called with place 1. The bust sweep floors
`basePosition` at `bustedOrdered.length + 1`; the unresolved-players loop uses
`ordered.length + 1 - i`. Both are `>= 2` deliberately, so that 1st stays
reserved for `finishTournament`. Code that compiled, typechecked, read
correctly, and had never once executed. On a Spin it is the entire ending: three
players, one winner, three minutes, and the winner is the one who saw nothing.

**The fix.** `finishTournament` now broadcasts `tournament_winner`
(`userId` / `position` / `prize` / `playerName`) **after** the payout reconcile,
so the row the client reads back is final, and **before**
`cleanupBroadcastChannel()` tears the channel down — broadcasting after
unsubscribe silently re-creates the channel and sends into a subscription nobody
is listening on.

**Its own event, not `player_eliminated` with position 1**, because
TournamentPage and TournamentLobbyPage both raise an elimination toast on that
event and announcing the champion to the whole field as knocked out is worse
than saying nothing.

`goToLobbyWithResult` was hoisted out of the `player_eliminated` branch to the
subscription scope so both events take the identical path, with an `exitStarted`
guard at the subscription's lifetime so a retried broadcast cannot schedule two
navigations.

### PR #244 — `77f8d67bb` — the changelog and the interim handoff

Docs only.

### PR #249 — `a95eb153c` — the finisher's exit never left the table

The audit of #242. Telling the winner turned out to be the only part that
worked. Six more defects, all in or around those same twenty lines:

**1. THE EXIT DID NOT LEAVE.** `goToLobbyWithResult` published the card and
navigated, and that was all of it. Every manual leave in TablePage sends four
more signals and a tournament finisher — winner **or** bust — got none of them:

| signal                                       | what its absence cost                                                                           |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `SESSION_ENDED`                              | PlayerStyleRadar, PerformanceTrends and StakeLevelComparison never refreshed after a tournament |
| `playerStatusService.clearPlayingAt(userId)` | "Playing At" kept pointing at a table the engine had already closed                             |
| `TABLE_LEFT`                                 | the finished table stayed in the tab bar                                                        |
| `TABLE_MENU_ACTION` / `CLOSE_TABLE_TAB`      | ditto — MultiTablePage subscribes to both and each removes the tab                              |

So Dan's _"you kick the current players and move them to the lobby"_
half-happened: navigated away, still seated everywhere that mattered.

**2. AND IN MULTI-TABLE THE NAVIGATE WAS DESTRUCTIVE.** TablePage runs as up to
four embedded instances inside MultiTablePage. An unconditional
`navigate('/clubs/...')` from one of them tears down the container and takes the
other three **live** tables with it — bust out of a three-minute Spin on tab 2
and your cash games leave the screen mid-hand. There the signals **are** the
exit: MultiTablePage removes just that tab and calls its own `goToLobby()` only
when it was the last one.

**The guard is `embeddedTableId`, NOT `isMultiTable`.** This is the subtlety
worth remembering. `isMultiTable` is a sound/UX flag — MultiTablePage passes
`tables.length > 1 || hidden`, so it is **false for a single visible table**
while the container is mounted and subscribed. Branching on it would have left
the commonest case with two navigators racing for the destination (this one to
the club, `goToLobby()` to the club or `/`), which is the same race the manual
leave path had to be untangled from in the first place. `embeddedTableId` is set
exactly when this instance lives inside the container. There is a test that
fails if anyone swaps it back.

**3. THE EXIT TIMER OUTLIVED ITS SUBSCRIPTION.** The winner's celebration beat
is 7s. A player moved off that tab inside it was force-navigated out of wherever
they had gone next. Held in `tournamentExitTimerRef` and cleared in the same
effect cleanup that tears down the tournament channels.

**4. EVERY TOURNAMENT WAS BRANDED A SPIN.** `TournamentRankingCard` hard-coded
the word SPIN into its banner, so a 128-runner MTT finished under a Spin badge.
`isSpin` now rides the payload, resolved by `isSpinTournament` from the
tournament row — and **`variant` AND `tournament_type` are both selected**,
because that helper checks both and selecting only one is how it quietly returns
false for half the Spins in the system.

**5. THE CARD IGNORED THE SESSION IT WAS HANDED.** `duration` and `handsPlayed`
had ridden in the payload since the card was written and it read neither, so a
Spin that ran 21 hands over three minutes said nothing about itself. It never
showed rebuys or add-ons either, which in a rebuy event are most of the story,
and its banner date came from `new Date()` rather than the session end. The cash
Session Complete card was given real stats in #243; this one is now level with
it, `vpipPercent` and `totalBuyIn` included. A new `.trc2__session` row shows
Duration and Hands, mobile-first at 375px, rendered only when known so an older
payload shows no empty row.

**6. DEAD CODE REMOVED RATHER THAN LEFT AS A TRAP.**

- `src/components/tournament/TournamentResultCard.tsx` + `.css` and ClubLobby's
  router-state reader. It could never work: the state was addressed to
  `/clubs/:clubId` (ClubHomePage) while only `/clubs/:clubId/lobby` read it, so
  the card was dropped on arrival every single time — and "the lobby" is three
  different pages (HomePage OR ClubHomePage OR ClubLobby), which is why the
  app-root host exists at all.
- `TournamentService.broadcastWinner` / `.broadcastElimination`, callerless and
  unusable: both facts belong to the engine, and a second publisher on that
  channel is how a table acts on a result the database disagrees with.
  **`broadcastWinner` sitting in the service unused is precisely what made
  "nothing announces the winner" so easy to miss for as long as it was** — to
  anyone grepping, it read as "the winner is announced somewhere."

### 2.1 The thing CI caught that I would otherwise have shipped blind

`CSS Beat E2E` went red on #249 and it was right to.
`tests/e2e/live-animations.spec.ts` mounted `.trc` / `.trc__backdrop` /
`.trc__card` and asserted the entrance timings of `TournamentResultCard` — the
component that PR deletes. **The spec was proving that a dead card had a
beautiful entrance, and it was the last thing in CI holding that stylesheet
alive.** Repointed at `.trc2` / `TournamentRankingCard` — same question, asked
of the card that exists (`trc2Fade` 200ms backdrop, `trc2Rise` 400ms card).

Verified the way CI does it rather than by reading: clean `npm ci`, real
`vite build`, the build served under `/hub/club-arena` on port 4173, all three
beat specs run against it. 60 passed.

### 2.2 The live architecture, so you do not have to re-derive it

```
ENGINE (Hetzner)  server/src/tournament/TournamentManagerEliminations.ts
   eliminatePlayer(user, place>=2) ──broadcast──> 'player_eliminated'
   finishTournament(winner)        ──broadcast──> 'tournament_winner'   [#242]
                                     both on supabase channel  t-break-<tournamentId>
        │
CLIENT   src/pages/TablePage.tsx   effect deps [tableId, userId]
   breakChan.on('broadcast','tournament_event')
        ├─ 'player_eliminated' → goToLobbyWithResult(place, prize, 2500)
        └─ 'tournament_winner' → setTournamentWinner() + goToLobbyWithResult(1, prize, 7000)
        │
   goToLobbyWithResult   (ONE implementation, hoisted to subscription scope)
     ├─ fetchTournamentResult(tid, userId)   reads tournament_players + tournaments
     ├─ publishSessionSummary({ ...session, tournament: {...} })
     ├─ SESSION_ENDED / clearPlayingAt / TABLE_LEFT / CLOSE_TABLE_TAB
     └─ if (embeddedTableId) return;  else navigate('/clubs/<id>')
        │
HOSTS    src/App.tsx, outside <Routes> so they survive the navigation
   SessionSummaryHost      renders when payload.tournament is ABSENT  (cash)
   TournamentRankingHost   renders when payload.tournament is PRESENT (tournament)
        │
CARD     src/components/tournament/TournamentRankingCard.tsx  (+ .css)
```

The split between the two cards is on the **presence of `payload.tournament`**,
never a boolean, so a tournament can never fall through to the cash summary and
report a chip profit for a seat where chips have no cash value.

### 2.3 Tests — there were ZERO on this path before today

| file                                        | what it is                                              | count |
| ------------------------------------------- | ------------------------------------------------------- | ----- |
| `tests/config/tournamentWinnerExit.test.ts` | source-level invariants, house `spinEngineWiring` style | 16    |
| `tests/unit/tournamentRankingHost.test.tsx` | behavioural, renders the host and reads the DOM         | 12    |

Both were checked the only way that means anything: reverted the source files to
`origin/main` and re-ran. **6 of 9 failed for #242, 11 of the new ones failed for
#249.** A test that passes against the broken code is worth nothing; run that
check on anything you add here.

What they pin, so you know what you will break: the broadcast exists and
precedes the channel teardown; it carries identity and prize; it is not
`player_eliminated`; TablePage handles it; there is exactly ONE
`goToLobbyWithResult`; the duplicate-exit guard is present; the four leave
signals fire; the publish precedes the teardown; the guard is `embeddedTableId`
and explicitly **not** `isMultiTable`; the timer is cleared; ClubLobby has no
router-state reader; the client has no broadcaster; Spin branding is
conditional; and `eliminatePlayer` still never uses place 1 (the reason the
winner path has to exist at all).

### 2.4 Proof it is live — not a green tick, production

```
CA main                5b009c2bf
production ca_sha      babdf81f0   (build-info.json, built 2026-08-22T19:15:44Z)
5056e6438 in it        YES
a95eb153c in it        YES
World Hub /api/health  433603fc
index-Cxj0FZeg-v6.js   contains trc2__session, TOURNAMENT, Duration
index-Cp6Atu5X-v6.css  contains trc2__session
Auto-Deploy Hetzner    success on the winner-broadcast commit
```

Full suite at merge: **233 files / 2955 tests green**, tsc clean (with a real
`npm ci`), Production Build green, CSS Beat E2E green.

---

## 3. ONE THING THESE THREE PRs DID NOT PROVE

**Nobody has watched a real Spin end from the winner's seat.** The engine
deployed, the path is pinned by 28 tests, and the code is verifiably in the
bundle production serves — but `CLAUDE.md` §11 is explicit that a workflow going
green is not behavioural verification, and this estate's whole failure history is
things that reported success.

The cheap confirmation, for whoever is next at a live table: finish a Spin as the
winner and check that (a) the ranking card appears in the lobby after the ~7s
celebration beat, (b) the finished table's tab is gone, and (c) it says SPIN, not
TOURNAMENT. In multi-table, check that the _other_ tabs are still there — that is
the regression that would hurt most.

---

## 4. STILL OPEN — verified against main at `5b009c2bf`, not copied forward

Renumbered from the union-reserve handoff's §6. **Two of its items are now done
and are not repeated below:** 6.3 (hero-card-row vertical assertion — PR #178
merged, `rowCentreY` assertions are on main at lines ~153/156) and 6.7/6.8 (the
null-multiplier spins and the unapplied `20260821_challenge_rerolls.sql`, both
closed by #248 `0443dad53`, which added
`supabase/migrations/20260822191000_spin_null_multiplier_repair.sql` and deleted
the dead migration).

### 4.1 Verify spins are a true 1:1 animation clone of cash games — OPEN

Dan asked for a verified clone of every cash-game animation on the Spin path.
Never audited end to end, and `git grep -l spin -- tests/e2e/` finds no spin
spec. The `CSS Beat E2E (multi-table + animations)` job already exists and is a
required check — **extend it rather than inventing a second mechanism.** Read
`.agent/handoffs/2026-08-21-css-beats-e2e-ci-job.md` for how the beats are
asserted, and §2.1 above for the trap: a beat can outlive the thing it guards.
Start from `src/pages/TablePage.tsx` and
`src/components/table/DealAnimation.css`.

### 4.2 `VITE_RIVE_RIGS=on` in the same commit as the first `.riv` — BLOCKED on art

The Rive runtime is gated out of the build (−182kB raw / −52kB gz) because no
artwork exists. Flag check is `src/components/table/RiveAvatar.tsx`.
`tests/unit/riveAvatar.test.tsx` pins **both** flag states on purpose — flipping
the flag without art will fail it, and that is intended.

### 4.3 Surface `spin_reserve_wallet` in the union UI — OPEN (World Hub)

The wallet exists, reads 0, and is only reachable via RPC. Confirmed today:
`pages/api/club-arena/union-wallet.js` in World Hub does **not** return the
column and nothing renders it. Needs the column in the API response, a display,
and a fund control wired to `fn_spin_reserve_wallet_fund`. Background:
`.agent/audits/2026-08-22-union-level-spin-reserve-wallet.md`.

### 4.4 Retire the 500x columns — reader first — OPEN

`v_spin_reserve_health` still publishes `top_jackpot`, `need_for_500x` and
`can_draw_500x` although the tier is retired. They were left deliberately:
World Hub `pages/api/cron/spin-sweep.js:101` still selects `can_draw_500x`
(verified today) and that reader deploys separately. **Ship the cron change,
wait for it to publish, then drop the columns.** Dropping a column a deployed
client selects is the 2026-08-21 dark-badge incident verbatim.

### 4.5 Open PRs blocking, not mine, worth knowing about

At the time of writing: **#265** (V12 real ICM + format awareness), **#264**
(the other four credit sites + a guard), **#258** (Help page redesign) — all
`BLOCKED`, which means "checks pending or failed", not "someone blocked it".
`mergeStateStatus` does not distinguish; use `gh run list --branch <ref>`.

### 4.6 Housekeeping shipped alongside this handoff

PR #262 committed six merge/patch artifacts to `main`:
`BusToastBridge.tsx.orig`, `BusToastBridge.tsx.rej`, `Toast.css.orig`,
`Toast.tsx.orig`, `Toast.tsx.rej`, `MasterBus.ts.orig`. The two `.rej` files
mean `patch` **rejected** those hunks; they were later applied by hand, so the
`clock` toast type is genuinely present in `Toast.tsx` and `BusToastBridge.tsx`
and the feature works. The files are pure detritus — but a `.rej` in `src/` is a
rejected change sitting in the tree looking like source, and the next agent
grepping for `clock` finds it twice. Removed here, and `*.orig` / `*.rej` /
`*.bak` added to `.gitignore` so it cannot recur.

---

## 5. TRAPS — carried forward, every one still live

1. **The shared clone `~/Documents/Smarter-Poker-Club-Arena` is not a place to
   work.** It runs dozens of commits behind, its `node_modules` is stale enough
   to break `vite build`, and `.husky/pre-commit` now refuses commits made in
   it. Claim a worktree (§1).
2. **A PR can merge without your latest commit.** Verify by CONTENT, never by
   SHA — a squash merge gives your work a new SHA, so
   `git merge-base --is-ancestor <your-sha> origin/main` correctly returns false
   for a squashed docs PR that did land. Use
   `git grep -c "<a symbol only you added>" origin/main -- <file>`.
3. **Autopilot may merge `main` into your branch server-side while you are
   working.** If your push is rejected with `fatal: bad object <sha>` from the
   pre-push hook, that is what happened: `git fetch origin <your-branch>` and
   merge it, do not force anything. If the resulting diff against
   `origin/<your-branch>` is empty, Autopilot's merge already contains your work
   and there is nothing to push.
4. **`git merge origin/main` into your feature branch is fine and safe.**
   Rebasing `main` is what is forbidden. `.husky/pre-rebase` enforces it.
5. **The Supabase manifest gate.** The CI job named "TypeScript Check" also runs
   `scripts/ci/check-migrations-applied.mjs`, which asserts every object your
   migrations declare exists in `scripts/ci/supabase-schema-manifest.json`.
   Add a table, view, column or function and you must regenerate the manifests
   in the same PR. Full procedure in §3 of the union-reserve handoff, including
   why the 10,000-line diff it produces is a formatting artifact and how to
   prove that semantically.
6. **The Supabase MCP times out intermittently** for minutes at a stretch.
   Retry; it is not your query.
7. **`psql` is installed but the stored DB password is stale.** The
   service-role key is current; only the password is dead. Use the MCP.
8. **Never call AI players "bots" — they are horses.** No emoji in source (it
   breaks the SWC compiler and fails the Vercel build). `.maybeSingle()`, never
   `.single()`. Popups are Title Case with no em dashes and go only through the
   Toast layer (`src/utils/popupStyle.ts`). Mobile-first at 375px.
9. **Never push a red test.** `npx vitest run tests/` in
   `build-for-world-hub.yml` is what PUBLISHES the bundle — a failing test stops
   the World Hub sync for every agent until a human notices. Writing the spec
   first is encouraged; committing it red is not. Mark it `it.skip()` with a
   note and remove the `.skip` in the commit that implements it. If you replace
   behaviour a test pins, update that test in the same commit (§2.1 is the
   worked example). If you find `main` already red, fixing it comes before your
   own work — you cannot ship past it anyway.
10. **One flaky failure I saw and could not reproduce:**
    `tests/components/CashierClubSwitcher.test.tsx` > "records the resolved club
    as last-visited" failed once in CI (`expected null to be 'bbbbbbbb-...-002'`)
    on a merge run, and passed locally on that exact merged tree and on every
    re-run. Smells like cross-file `localStorage` bleed under vitest's shared
    worker. If you see it again it is probably not you — but it is worth
    isolating rather than re-running.

---

## 6. FIRST FIVE MINUTES

```bash
cat AGENT-PLAYBOOK.md                                    # the source of truth
eval "$(bash scripts/agent-workspace.sh <you> fix/<slug>)"
npm ci                                                    # in YOUR tree, not the shared clone
npx vitest run tests/ 2>&1 | tail -5                      # expect ~2955 passing, 0 failed
curl -s https://smarter.poker/hub/club-arena/build-info.json
```

If that baseline is red, fixing it comes before your own work.

Then read, in this order:
`.agent/handoffs/2026-08-22-union-reserve-and-shipping-from-cowork.md` (§3, the
Supabase manifest gate), `.agent/audits/2026-08-22-union-level-spin-reserve-wallet.md`,
`MIGRATION-CHANGELOG.md` (the two 2026-08-22 tournament entries), and
`CLAUDE.md` §5 and §12.
