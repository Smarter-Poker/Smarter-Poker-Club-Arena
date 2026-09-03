# The sweep was scoped to the sample, not to the property

2026-08-25, Cowork session. Brief was "get everything up to date, finish
anything necessary before we start making mobile updates." What follows is
what was actually wrong, in the order it was found.

## 1. Two MTTs at a dead felt, covered by no sweep at all

`Monday Grind PLO6 Turbo` had been RUNNING for **183 minutes with zero hands**,
18 paid players seated. `Six-Card Late Night` for 16 minutes: 499 players, 56
tables, 548 live seats, zero hands. Buy-ins committed on both.

The started-but-never-dealt recovery added on 2026-08-24 should have caught
them. It could not, because it shipped as:

```js
.eq('status', 'RUNNING')
.in('variant', ['sng', 'spin'])      // <- the whole defect
.lt('started_at', neverDealtCutoff);
```

The outage that prompted that sweep was 92 seat-first games, so the filter was
written around the sample. Its own comment three lines above says _"No existing
sweep covers this state"_ — and the filter then made that literally true for
every MTT variant. **"Started and never dealt" is a property of a tournament,
not of its variant.**

Fixed in #780: filter removed, plus a seating-settled guard so a large MTT
still filling tables is not requeued mid-seating (every player still `playing`
must hold a live seat; an unreadable count is UNKNOWN, not settled).

### The 15-minute cutoff was measured, not assumed

The obvious objection is that MTTs are slower to first hand than spins, so
reusing a seat-first cutoff would requeue healthy games. The data says
otherwise — 187 non-seat-first tournaments started in 48h:

| time to first hand | n   | avg field |
| ------------------ | --- | --------- |
| under 5 min        | 127 | 42        |
| 5-15 min           | 26  | 45        |
| 15-30 min          | 6   | 19        |
| 30-60 min          | 4   | 31        |
| over 60 min        | 13  | 31        |
| never dealt        | 11  | 66        |

153 of 187 deal inside 15 minutes, **including a full 500-player field**. And
the slow tail's average field is _smaller_ than the fast group's (31 vs 42), so
it is not big fields seating slowly — it is this same stall, recovering by luck
on a later re-adoption. 15 minutes is roughly 3x the healthy p95.

## 2. The fix works, and it is a retry loop rather than a cure

Verified live end to end: engine cut over to `137247b2`, the sweep requeued
both games (RUNNING -> REGISTERING), the start gate relaunched both with fresh
`started_at`, and the engine adopted their tables — 295 tables known against
294 running in the database.

**They still did not deal.** The engine's own per-table state says why:

```
c766fbcc  loopPhase 'dealing+30s'  seated 9  dealable 9  msSinceProgress 107845
167d516a  loopPhase 'dealing+29s'  seated 9  dealable 9  msSinceProgress 107846
```

Nine seats, every one holding chips, none sitting out, not paused, engine
attached — and **wedged inside the deal step** for 108 seconds on a phase that
should take milliseconds.

So #780 rescues the state; it does not cure it. If the deal step wedges again
the sweep requeues on a ~15 minute cycle. That is better than a permanently
dead felt and it is not a fix, and it is deliberately not written up as one.

### The wedge has a shape, and a much worse baseline underneath it

Both games are six-card. First-hand success by `game_type`, 48 hours:

| game_type | tournaments | never dealt | %        |
| --------- | ----------- | ----------- | -------- |
| NLH       | 2949        | 659         | 22.3     |
| PLO4      | 2390        | 496         | 20.8     |
| PLO5      | 1124        | 404         | **35.9** |
| PLO6      | 1049        | 383         | **36.5** |

PLO5/PLO6 fail at ~1.7x the NLH/PLO4 rate. But the headline is the baseline:
**about one tournament in five never deals a card — ~1,942 in 48 hours.**
Until #780 an MTT in that state was invisible to every sweep, which is the most
likely reason nobody had that number.

Raised as #782 with the instrumentation needed: `loopPhase` reports one label
for the whole deal operation, so a 108-second stall and a 3ms deal look
identical from outside. Not guessed at here on purpose.

## 3. Four stuck pull requests, two of which were reverts wearing a fix costume

All four open PRs were DIRTY, and all four touched table/mobile UI — the files
the next session is about to work in.

- **#761** — resolved to main's side: main adds `onCardBackChanged?.(id)`, the
  branch simply predates it.
- **#744** — resolved by **splitting the hunk**, which is the whole argument for
  never taking a whole side. The branch's functional updater
  `setStandUpNextBB((prev) => !prev)` is a real stale-closure fix and was kept.
  The same change to `setIsAutoRebuyEnabled` is wrong: that one is a wrapper
  typed `(v: boolean) => void`, not a `useState` setter, so an updater would be
  stored as a value. Main's form kept there, with a note saying why.
- **#733 — closed.** Every hunk superseded by #758. After resolving them all to
  main the entire remaining diff was 10 lines of `SeatSlot.css`, and those 10
  lines were a byte-for-byte re-add of the opponent card rotation that #742
  deliberately deleted. Merging it would have been a silent revert.
- **#716 — closed.** Exact duplicate of #717, same title, sibling branch, and
  #717 merged 2026-08-24T22:14Z. 62 commits behind, with 12 further mobile-lobby
  commits landed on top of it since.

Half the open PR queue was work that had already shipped or been rejected.

## 4. Stranded work: the warning was almost entirely false

`agent-workspace.sh` reports commits GitHub has never seen. It named five
branches, ~10 commits, some 19 hours old. **Every one was already on main under
a different SHA** — verified by comparing blob hashes at each path, not by
filename:

| branch                                            | verdict                            |
| ------------------------------------------------- | ---------------------------------- |
| `claude-cowork/fix/estate-verify`                 | identical to main                  |
| `claude-cowork-transient/...`                     | identical to main                  |
| `cowork-lastthree/...`                            | identical to main                  |
| `claude-cowork-fees/...`                          | superseded by the transient commit |
| `cowork-handoff/...`, `/tmp/ca-land`, SPCA `main` | stale bases; diffs are reverts     |

These branches sit on ancient bases, so `origin/main..HEAD` shows ~1000 files
and 100k+ deletions. **Pushing any of them would have opened a PR reverting most
of the repo.** This is the duplicate-SHA problem in CLAUDE.md section 12 seen
from the other end.

The warning is therefore mostly noise — and noise is where a real stranded
commit hides. 27 dirty trees were snapshotted to `refs/wip/rescue/20260825T045141Z/*`
as insurance; nothing was pushed and nothing was deleted.

## 5. Estate drift, both halves, in opposite directions

Issue #682 named two files split across the seven repos. They did not sync the
same way, which is the point:

- **`AGENT-PLAYBOOK.md`** — Club Arena newer (2026-08-24T20:06Z vs 05:56Z). The
  six stale copies still forbade `npm install` inside a worktree and sent the
  reader to run `npm ci` in the shared clone, which stopped being true when
  `agent-workspace.sh` began giving each tree its own copy-on-write
  `node_modules`. Six repos were instructing every agent to install in the one
  place it is now most disruptive. Synced Club Arena -> the rest.
- **`agent-autopilot.yml`** — PepNationLab newer (Dependabot, `checkout@v4.3.1
-> v7.0.1`, `create-github-app-token@v1 -> v3`). Synced Pep -> the rest.

The second one mints the token Autopilot merges with, so it was staged rather
than pushed everywhere at once: `commander-shared` bumped alone first, its sweep
on the bumped SHA confirmed green, and only then the remaining repos. A broken
mint fails that step on every sweep, so this is a positive result rather than an
absence of evidence.

**Deciding "which side is canonical" per file is the actual work here.** A
script that just made them agree would have reverted a Dependabot security bump
half the time.

## 6. Things found and deliberately not changed

- **The canonical clone was on `docs/playbook-schedule-wait`, not `main`**,
  because a stale agent worktree held `main` at a 2-day-old commit. That tree was
  clean and 0 ahead, so it was removed and the clone fast-forwarded to
  `origin/main`. It could not be switched onto `main` itself, because —
- **there is live uncommitted mobile work in the shared clone**: 210 insertions
  across `ClubBottomNav.tsx` (+332), `MarketplacePage`, `PlayerStatsPage`,
  `ClubDataPage`, implementing a binding instruction dated today about the
  bottom nav rendering every tab except the current page. Modified minutes
  before it was found. Snapshotted to
  `refs/wip/rescue/shared-clone-mobile-20260825T050552Z` and otherwise left
  completely alone — it is somebody's work in flight, and it is in the exact
  area the next session starts in.
- **`Smarter-Poker-Club-Arena` is a third real clone, not a symlink.**
  `AGENT-PLAYBOOK.md` section 1b states the old directory names are now symlinks
  to the canonical clone. They are not; it has its own object store and its own
  worktrees, which is where all of section 4's phantom stranded work lives.
  Restructuring it under 167 live worktrees is not a thing to do unasked.
- Credentials were audited on request: every real `.env` in both repos is
  gitignored, only `.env.example` files are tracked, and no `.env` was ever
  committed. `CRON_SECRET` is empty in World Hub `.env.local`, matching the
  known open item. The production Postgres password committed to main on
  2026-08-23 still needs rotating — human-only, unchanged by this session.
