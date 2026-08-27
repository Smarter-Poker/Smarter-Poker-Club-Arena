# OPERATION HANDOFF — CLUB ARENA TOURNAMENT LOBBY

**From:** Cowork/Claude · **Date:** 2026-08-26 · **Repo:** `club-arena`
**Classification:** binding. Every line below is evidenced. Nothing is speculative polish.

---

## 0. SITREP — READ THIS BEFORE YOU TOUCH ANYTHING

The tournament lobby was rebuilt end to end over one session. Six PRs merged and
are **verified live in production**; one is open with auto-merge armed.

| PR       | Merge SHA    | What it did                                                                 |
| -------- | ------------ | --------------------------------------------------------------------------- |
| #845     | `987d48991b` | Seven tab components, shared 3D layer, `observeTable`, MTT row routing      |
| #879     | `20f0bed016` | Wired the tabs into the page shell, locked the footer                       |
| #911     | `2ddada97cb` | Stopped the MTT cards moving; removed the search field                      |
| #915     | `0cda3ef63b` | Fixed a regression #911 shipped (boot-cache guard)                          |
| #939     | `851eb0da62` | Level-timer write, seven-tab reconciliation, tablist a11y                   |
| #952     | `3b1bc611e2` | Automated rescue of stranded commits (not authored, but contains this work) |
| **#959** | **OPEN**     | Mystery bounty celebration + retirement of 4 components                     |

Production last served `ca_sha 00a1f2bb79`. Verify what is live yourself:

```bash
curl -s "https://smarter.poker/hub/club-arena/build-info.json?cb=$(date +%s)"
git merge-base --is-ancestor <merge-sha> <ca_sha> && echo LIVE
```

**Scale of the change:** `TournamentDetails.tsx` went 2,161 → ~880 lines. Four
components retired (2,439 lines). Roughly **300 new assertions** across ~8 new
test files. Suite at handoff: **424 files / 6,872 tests passing**, tsc clean.

---

## 1. RULES OF ENGAGEMENT — non-negotiable, and each one cost me real time

### 1.1 Claim a worktree. The shared clone is hostile ground.

```bash
cd ~/Documents/club-arena
git pull --ff-only
eval "$(bash scripts/agent-workspace.sh <your-name> fix/<short-slug>)"
```

`~/Documents/club-arena` is `git reset --hard`'d by another agent **repeatedly
and without warning**. I lost a full session of work to it before moving to a
worktree, and **two sub-agents lost work the same way mid-task** — after their
edits had already passed tsc and vitest. A commit hook refuses commits there
anyway. Commit early, commit often, and re-check your edits are still on disk
before you report anything done.

### 1.2 `--no-verify` is FORBIDDEN, and you will not need it

The pre-push guards **grep file CONTENTS**, not just code. A code _comment_
quoting a banned string trips them. I lost three pushes to exactly this:

- a comment naming the raw GoTrue auth call → tripped the auth guard
- a comment quoting the removed search placeholder → tripped my own test
- an `&apos;s` possessive → tripped `check-title-case`

**Reword the comment.** Do not bypass. Run these yourself before pushing:

```bash
node scripts/ci/check-title-case.mjs
node scripts/ci/check-ui-text.mjs
```

### 1.3 Commit messages go through a file

```bash
git commit -F /tmp/msg.txt
```

Inline messages break the shell on parentheses and backticks. And **do not
`git add -A` right after writing that file** — you will commit the message
itself. (I did. `.gitignore` now has `.git-msg-*.txt` because of it.)

### 1.4 Commit author is CI-enforced

```bash
git -c user.name="Smarter-Poker" \
    -c user.email="254329056+Smarter-Poker@users.noreply.github.com" commit ...
```

Vercel refuses to build a commit it cannot attribute — the deployment goes to
BLOCKED with **no build logs at all**, so nothing else in CI can see it.

### 1.5 Two tests fail in a Linux sandbox and are NOT broken

`tests/unit/currentLevelIsAnIndex.test.ts` and
`tests/unit/chipsAreTheDefaultNotBB.test.ts` shell out to `git ls-files`. A
worktree's gitdir is a macOS path that does not exist inside a Linux sandbox, so
git fails there and only there. **They pass on the host and in CI.** If only
those two fail, it is the environment — say so, do not "fix" them.

Run the suite as: `TMPDIR=/tmp node ./node_modules/vitest/vitest.mjs run tests/`
(the sandbox scratch disk fills and npm's own logging fails otherwise).

### 1.6 RULE 11.5 — never spend real chips to test a rule

`fn_collect_bounty` **moves chips**. Do not call it. Read its definition with
`pg_get_functiondef`, or probe inside a transaction you **ROLL BACK**
(`scripts/dev/probe-rpc.sql` is the pattern — what you want is the error
message, which survives a rollback). Helper functions go in `pg_temp`, never
`public`. If you cannot probe without committing, **do not probe** — assert the
logic in a unit test and say plainly that the live path was reasoned about
rather than executed.

---

## 2. PRIORITY ONE — NOBODY HAS OPENED THIS IN A BROWSER

**This is the single largest gap in the entire body of work, and it is yours.**

Every claim rests on production SQL, unit tests, and frame-by-frame analysis of
a screen recording. The sandbox had no route to a browser. **The mechanisms are
proven. The pixels are not.**

Go to `https://smarter.poker/hub/club-arena/` → a club → an MTT row → the
tournament lobby. **On a real phone at 375px.** Then verify each of these, and
report what is actually wrong rather than confirming what you hope:

| #   | Check                                                                            | If it fails, start here                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Detail fits one screen, no scrolling**                                         | The shell MEASURES its space into `--details-h`. `100dvh` is wrong here — `AppLayout` renders `GlobalHeader`, optionally an announcement banner and an offline banner, and `<main>` adds padding, so a 100dvh shell is taller than the viewport by exactly that chrome. A constant is not available either: `--header-height` is declared in **three token files with two different values** (44px and 56px) and the header grows when it wraps. See the `ResizeObserver` effect in `TournamentDetails.tsx`. |
| 2   | **Footer flush to the bottom, no gap**                                           | It is a flex child now, not `position: fixed`. The old bug was `bottom: var(--bottom-nav-clearance, 74px)` reserving room for a nav this page does not render.                                                                                                                                                                                                                                                                                                                                               |
| 3   | **Blinds clock ticks, never `0:00`**                                             | Anchors to `tournaments.level_started_at`. The old code passed `level_start_time`, which **is not a column**, so it anchored to tournament start, went negative, and clamped to zero permanently.                                                                                                                                                                                                                                                                                                            |
| 4   | **Detail one screen at 430px too**                                               | Same measurement; different chrome height.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 5   | **Ranking**: hero row pinned, moved rows light their rim, Mine Only filter works | Realtime bursts are coalesced at 250ms. If it feels laggy under load, that window is the dial.                                                                                                                                                                                                                                                                                                                                                                                                               |
| 6   | **Tab strip: Left/Right arrows move and WRAP; Home/End jump**                    | Built and unit-tested, but **nobody has physically pressed the keys**.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 7   | **Entries** shows avatars, not initials                                          | Needs the `profiles!user_id` embed to be resolving.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 8   | **Rewards** payout bands read correctly (1st, 2nd, 3rd, then `4-6`)              | The range parser is new.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 9   | **A `?tab=chips` deep link lands on Ranking**                                    | `normaliseTabId` in `details/types.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 10  | **Cash / Spin / SNG rows still open the buy-in drawer**                          | Only `kind === 'mtt'` routes to the lobby. If a cash row navigates, that is a regression in `openEntry`.                                                                                                                                                                                                                                                                                                                                                                                                     |

---

## 3. WORK ITEMS — ordered, with evidence

### ITEM A — The lobby mystery-bounty chest is dead code

**File:** `src/pages/TournamentPage.tsx:858`

```js
if (data?.playerName && data?.amount)
```

That broadcast payload has **never carried `playerName`**, so this animation has
never once played. PR #959 added `amount` to the chest reveal (needed for the
celebration toast), which leaves the gate still failing on `playerName`.

**Decide and finish. Do not leave it half-wired.**

- **Option 1:** add `playerName` to the chest reveal in
  `server/src/tournament/TournamentManagerEliminations.ts` (~line 1929) and let
  it play. **But note the TABLE already plays a full chest animation** — confirm
  with Dan he wants two.
- **Option 2:** delete the dead gate and its animation.

### ITEM B — The client is a redundant second writer of `current_level`

**Files:** `src/services/TournamentTimerService.ts`, `server/src/tournament/TournamentManagerBase.ts:2876`

The Hetzner engine is authoritative. `TournamentTimerService` **also** writes
`tournaments.current_level`.

I fixed the _value_ it writes — it was `levelIndex + 1` into a **0-based**
column. Because the reader is fed its own output it **compounds**: read N →
write N+1 → read N+1 → write N+2, **once per second**. A runaway, not an
off-by-one. Currently dormant because `initializeAllTimers` has **zero callers**
in `src/`. A loaded gun, unloaded.

**The real end state is that the client should not write that column at all.**
That is a design decision, not a bug fix, which is why I stopped. Confirm the
engine is the only writer that matters, then remove the client write and the
`initializeAllTimers` dead path with it.

**Evidence the column is 0-based — do not re-derive this:**

- `current_level == floor(elapsed / level_duration)` **exactly** on every RUNNING
  event with a uniform structure (9 at 1718s/180s, 8 at 1504s, 7 at 1418s, 5 at 980s)
- `blind_structure[current_level].level == current_level + 1` in every row
- across **33,066 rows** `current_level` is never null; 813 sit at exactly `blind_structure.length`
- the SQL gate in `process_tournament_rebuy` compares `v_level >= v_cap` on the raw column

**One behaviour change already shipped in #939, on a money path.** The reader's
old guard `serverLevel < blinds.length` dropped auto-escalated rows (3,079 of
them) onto a wall-clock path that caps at `length-1`. Removing that cap flips a
rebuy gate from open to **CLOSED** where the cap exceeds `length-1` — closing a
window the database had already closed, so the client stops offering a button
the RPC rejects. Toward parity, never the reverse. 1,166 rows meet the
condition, 99 had rebuys enabled, and the one RUNNING event in that regime does
not flip. **If Dan reports a rebuy button vanishing, this is why — and it is correct.**

### ITEM C — A pko + mystery-bounty event gets no prize rank

`fn_collect_bounty`'s CASE returns `'pko'` when a tournament is flagged **both**
pko and mystery, and `paid_cash` is then only **half the head**. Ranking half a
payment against a ladder of whole heads would report a rung nobody pulled, so
`prizeRank` is deliberately not computed for that mode and the celebration will
not fire for it.

**Ask Dan whether such an event will ever be configured.** If yes, decide what
"top 3 pull" means when the payment is half a head. If no, record the answer and
close it.

> **CLOSED 2026-08-26.** Dan, verbatim: "no, never pko+mystery bounty ever."
> Recorded as an invariant, not a note: DB constraint
> `tournaments_never_pko_and_mystery` (migration `20260826210000`, applied to
> production and probe-verified in a rolled-back transaction — the UPDATE
> raises 23514) makes the hybrid impossible to configure. Zero rows in the
> table's history ever carried both flags. The engine's no-prizeRank branch
> stays as defense-in-depth, with its comment updated to cite the ruling.

### ITEM D — Dead comment pointers (5 minutes)

Comments citing files deleted in #959, by line number:

- `src/components/tournament/details/EntriesTab.tsx:29` and `:146` → "see LiveChipCounts.tsx:71" / "its line 88"
- `src/pages/tournament/TournamentDetails.tsx:678` → "see its line 88"

### ITEM E — Surfaces nobody has audited to the same standard

The seven tabs got a line-by-line audit. These did not, and they are adjacent:

- **`GameLobbyPanel`** — the pre-commit drawer that cash/Spin/SNG rows open. It
  is the **buy-in surface**, so it matters most. Hunt the same defect classes
  the tab audit found (below).
- **`LobbyTable` / `lobbyEntries.ts`** — the row view-model. `mergeFastRows` now
  protects the lists from partial rows, but the renderers were never reviewed.
- **The Spin surfaces** — `spin_multiplier` is one of the five columns
  `get_club_home` omits, so Spin badges had the same flicker MTT cards did.
  Fixed at source; Spin-specific rendering unreviewed.

**The defect classes worth hunting** (every one was found for real in the tabs):

1. Nulls on `any`-typed columns — `Tournament` has an index signature, so **TypeScript is not protecting you**. `.toLocaleString()` on undefined throws.
2. Division by zero → `NaN%` / `Infinity` reaching the DOM (average stack with zero players, a meter width of `x/0`).
3. Leaks — intervals, listeners, `ResizeObserver`, supabase channels, `setState` after unmount.
4. **Divergent definitions of the same thing.** Four tabs had four definitions of "still in", so Remaining and Average Stack could disagree between two tabs of one screen.
5. **A failed query rendered as an empty field** — the named house bug shape.
6. `key` using array index where rows re-sort (swaps DOM state between rows).

---

## 4. THE MAP — where everything now lives

```
src/pages/tournament/TournamentDetails.tsx   the SHELL. Loads, keeps live,
                                             owns registration + footer.
                                             Draws NO tab content.
src/components/tournament/details/
  types.ts            TabId, TABS, normaliseTabId, TournamentTabProps,
                      chips/chipsCompact/ordinal/clockText/initials,
                      isPlayerOut/isPlayerLive, the payout-range parser
  DetailOverviewTab   one-screen overview, clock band, badges, deal vote
  BlindsTab           current level, next level, break countdown
  RankingTab          was Chips. realtime, hero pin, downline, observe
  EntriesTab          registration order, avatar, player number, rebuys
  UnionsTab           participating clubs, logo, level, entrants
  TablesTab           one table per line, smallest/avg/biggest stack
  RewardsTab          payouts in order, bounty pools, mystery ladder
  useDownlineIds.ts   agent hierarchy, role-gated, cycle-safe
src/styles/tournament-lobby-3d.css   the `tl-` vocabulary ALL tabs share
src/utils/observeTable.ts            cap-aware open-in-new-screen
src/hooks/useTournamentEntries.ts    entry load for TournamentPage
server/src/tournament/mysteryPrizeLadder.ts   pure prize-rank rules
```

**The contract:** every tab takes exactly `TournamentTabProps`. The page has
already loaded the tournament row, entries and tables and keeps them fresh over
realtime — **use the props**. A tab that re-fetches the same rows makes the
lobby slower and can render figures that disagree with the tab beside it. Fetch
your own only for data no other tab needs (union roster, bounty ledger,
downline), behind a cancellable effect that tolerates an empty result.

**The design language:** strict smarter.poker palette — surfaces
`#223046 → #1a2436 → #131b28 → #0d1120`, accent `#6fdcff / #00b4e6`, action
`#1877f2 / #0a5dc2`, text `#e8eaf0 / #8892a4 / #6b7686`, refusal
`#ef4444 / #ffb4b4`. **NO BROWN, NO YELLOW, NO GOLD** — enforced by a hue test
that rejects saturated colour in the 20-70° band, so a prize screen cannot creep
back to gold. Depth is three layers, always in order: top-down gradient, then
`inset 0 1px 0` highlight + `inset 0 -1px 0` shade, then a cast shadow.

**The tests that will stop you** if you regress any of it:

```
tests/unit/tournamentLobbyTabContract.test.ts        the shared contract + helpers
tests/unit/tournamentLobbyTabsAreClean.test.ts       leaks, palette hue, a11y
tests/unit/tournamentLobbyShellIsAccessible.test.ts  the tablist pattern
tests/unit/lobbyCardsDoNotFlicker.test.ts            mergeFastRows + 20-reload replay
tests/unit/mttRowOpensTournamentLobby.test.ts        MTT routing rule
tests/unit/mysteryBountyCelebrationContract.test.ts  client/server payload agreement
server/src/tournament/mysteryPrizeLadder.test.ts     prize-rank rules
tests/unit/tourneyUxSweep20260825.test.tsx           Dan's ten UX findings
```

---

## 5. FOUR THINGS THAT MUST NOT BE REVERTED

If you resolve a merge conflict in this area, these are the sides to keep:

1. `TournamentTimerService` writes **`levelState.levelIndex`**, NOT `+ 1`.
2. The lobby fast-path guard is **`if (listsPaintedRef.current) return;`**, NOT `hasDataRef.current`. `hasDataRef` is seeded from a boot cache holding club+tables but **no tournaments**, so gating on it shows a returning player a **blank MTT board**.
3. The tab strip keeps its roving-focus keydown handler and `aria-controls` / `aria-labelledby` wiring.
4. `TournamentStandings`, `LiveChipCounts`, `BlindLevelProgress` and `TournamentStatsDashboard` stay **deleted**. (Note: `src/components/common/Progress.tsx` exports a _different, unrelated_ `BlindLevelProgress` — leave that one alone.)

---

## 6. WHAT IS ALREADY DONE — DO NOT REDO IT

Dan's original ten-point brief is closed: MTT rows open the lobby at any status;
the footer is locked flush; all seven tabs carry the 3D language; Detail is one
screen; Blinds shows current + next + break countdown with a working clock;
Chips became Ranking with realtime, hero position, observe-in-a-new-screen and
downline highlighting; Entries shows registration order with avatars, player
numbers and rebuys; the old Ranking tab is deleted; Unions lists participating
clubs; Tables is a one-per-line list with stack spread; Rewards shows payouts in
order with bounty and mystery pools.

**Bugs found and fixed along the way that nobody had reported:**

- the Blinds clock frozen at `0:00` on **every** tournament, forever
- every Spin's blind levels **60× too long** (seconds key read as minutes)
- the money bubble announced **seven places early** (a range payout row counted as one paid place)
- two tabs quoting **different prizes for the same finish**
- `ordinal()` printing the literal string **`NaNth`**
- a **failed query rendered as a field of zeros**
- the whole field drawing **initials** because `avatar_url` was hardcoded null
- **two 15-second polls** of the same table, now one
- the mystery bounty celebration silently returning at `if (amount <= 0)` because the chest broadcast sent `amountCents` and the component reads `amount`

---

## 7. YOUR DEFINITION OF DONE

Per `.agents/rules/00-agent-playbook.md` RULE 1 — paste real output, no claim
without a command behind it:

```bash
git status --porcelain              # empty of tracked files
git log --oneline origin/main..HEAD # your commits
gh pr list --head <your-branch>     # a PR exists
pwd                                 # under .agent-trees/
npx tsc --noEmit
TMPDIR=/tmp node ./node_modules/vitest/vitest.mjs run tests/
npm run build
node scripts/ci/check-title-case.mjs && node scripts/ci/check-ui-text.mjs
```

Then **push, open a PR, and DO NOT STOP THERE.** Finishing is merging. Set a
timer, watch the PR go green, and if CI fails **pull the logs and fix it
yourself** — do not wait for a human and do not abandon it. "Tests pass" without
a count is not an answer. And you may not say "it is deployed" until you have
checked what production actually serves.
