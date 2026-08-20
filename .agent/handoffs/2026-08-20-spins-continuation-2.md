# HANDOFF — Spins, continued (W1–W4 and part of W7 done)

**From:** Claude (Cowork) · **Date:** 2026-08-20 · **Supersedes the work queue in:**
`.agent/handoffs/2026-08-20-spins-and-animations-continuation.md`

That document is still the best explanation of _why_ any of this is shaped the
way it is — the economics, the animation traps, the fire-and-forget event
hazard. Read it. This one only updates what is left.

Full evidence for what changed:
`.agent/audits/2026-08-20-spins-reveal-payout-and-locked-tiers.md`

---

## ORIENTATION (do this first, it will save you an hour)

```bash
cd ~/Documents/Smarter-Poker-Club-Arena
git fetch -q origin main && git merge --ff-only origin/main    # host main lags; /tmp pushes never advance it
cd server && npm ls @sentry/node || npm install --no-save '@sentry/node@^10.46.0'
```

**That last line is not optional.** `@sentry/node` is in `server/package.json`
and was missing from `server/node_modules`. Without it, 36 of 87 server test
files fail to load and `tsc` reports 3 phantom errors — which is why the
previous handoff recorded a clean baseline it had never actually seen.

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:/opt/homebrew/bin:$PATH"
npx vitest run                      # expect 2,458 pass / 189 files
cd server && npx vitest run         # expect 969 pass / 87 files
npx tsc --noEmit                    # 0, both projects
```

```sql
SELECT * FROM v_spin_reserve_health ORDER BY balance DESC;
```

**The Cowork sandbox (`mcp__workspace__bash`) is a session-start snapshot with
no git credentials.** It will show you a repo ~29 commits stale and tell you
files that exist do not. Use `mcp__counselors__host_terminal` for anything real
— it runs on Dan's Mac with working credentials. It does not have node or gh on
its PATH, and it times out at ~100 seconds, so long waits must be `nohup`'d to a
log and polled.

---

## STATE

|                                |                                                                           |
| ------------------------------ | ------------------------------------------------------------------------- |
| Club Arena                     | `61a4ad0a8`                                                               |
| World Hub                      | `df396be40b`                                                              |
| Live `ca_sha`                  | `2330da610` (`61a4ad0a8` syncing behind it)                               |
| Pools                          | 3 · Midway ~10,000 · JAQK 5,000 · SHARK 5,000 · 0 unbooked · 0 shortfalls |
| Spins with `spin_locked_tiers` | rising from 0 since 21:41Z                                                |

---

## DONE

- **W1** — the multiplier no longer leaks before the wheel. It was in **eight**
  places, not the three the last handoff named; the rule now lives once, in
  `src/utils/spinReveal.ts`. `plo6` added to `createSpin`'s game-type map (a
  PLO6 Spin would have been created as NLH).
- **W2** — the 120% overpay is gone. A Spin rebuilds its own split from
  `spinTier()`; the winner-take-all fallback is capped at the unspent pool for
  every format. `server/src/tournament/payoutStructure.ts`.
  **See "still open" below — the end-to-end run is NOT done.**
- **W3** — locked tiers reach the wheel, persisted at draw time on a new
  `tournaments.spin_locked_tiers` column. The wheel names the cheapest unlock.
- **W4** — the sweeper runs every 15 minutes on Open Claw. A thin or short pool
  returns 500 on purpose; the reasoning is in the file header.
- **W7 (part)** — `FlashTransition`, `SpinItWheel`, `spinIt.ts` and
  `MysteryBountyReveal` deleted. 15 keyframes out of the global namespace.

---

## STILL OPEN, in the order I would take them

### 🔴 1. No 10x or 25x Spin has ever paid 2nd and 3rd

The guard is in and unit-tested; the live path has not run. Those tiers are
~1.1% of draws, so a natural one is hours away.

I tried to force one and stopped on purpose: the gap between `created_at` and
`started_at` is **3–7 seconds** and settlement books the pool at start, so
patching `spin_multiplier` after settlement desyncs `prize_pool` from the
ledger. Racing that window against production money to test a guard is a worse
trade than the guard.

The safe way, and the script is already on Dan's Mac at `/tmp/force_spin2.sh`:
a conditional PATCH filtered on `started_at=is.null`, so **losing the race is a
no-op** rather than damage. Run it, let one 10x and one 25x complete, then:

```sql
SELECT t.spin_multiplier, t.prize_pool,
       count(*) FILTER (WHERE tp.prize > 0) AS paid,
       round(sum(tp.prize)::numeric, 2)     AS total_paid
FROM tournaments t JOIN tournament_players tp ON tp.tournament_id = t.id
WHERE lower(coalesce(t.variant,'')) = 'spin' AND t.status = 'COMPLETED'
  AND t.spin_multiplier >= 10 AND t.created_at > '2026-08-20 21:40:00+00'
GROUP BY t.id, t.spin_multiplier, t.prize_pool;
-- 10x -> paid 2, total_paid = prize_pool
-- 25x -> paid 3, total_paid = prize_pool
```

Better still, do it on SHARK CLUB or Club JAQK — both have a funded 5,000 pool
and run zero spins, so a mistake costs nothing real.

### 🟠 2. The locked segments have still never been seen with real data

All three pools are well funded, so `spin_locked_tiers` is `[]` on every spin
and nothing dims. Correct behaviour, zero coverage. Under-seed a test club
(`fn_spin_reserve_seed`, small amount, high `highest_stake`), open a Spin there,
and confirm 100x/500x render dimmed with their thresholds and that the engine
never draws them.

### 🟠 3. `spin_multiplier` still reaches the client before the wheel

Every visible surface is closed, but the lobby queries still SELECT the column,
so devtools can read the answer early. Closing it means withholding the column
server-side for un-started Spins — an RLS or view change, and its own piece of
work.

### 🟡 4. The rest of W7 / W8 from the previous handoff

- The knockout head is always an initial: `KnockoutAnimation` accepts
  `eliminatedAvatar`, `TournamentManagerEliminations` broadcasts names only.
  Add the avatar URL to the payload.
- Bomb-pot pacing is unreachable (0 tables have `bomb_pot_enabled`) — verify
  before building anything.
- Nobody has confirmed the pacing constants feel right in a seated session.
  Every value is a named constant and trivially retunable. This needs a human
  at a table, not another test.
- The bounty chest, the knockout and the wheel have never been watched by a
  human in a real game. `tests/e2e/live-animations.spec.ts` drives real Chrome
  against live production CSS and reads `document.getAnimations()` — extend it.

### 🟡 5. `SpinCard` still shows the `winner-takes-all` badge

True for ~87.4% of games and false for the rest, and it is shown before the
draw so it cannot know. Left alone because the badge looks asset-backed; check
before changing.

---

## TWO TRAPS I HIT THAT ARE NOT IN THE OLD HANDOFF

**Fixed-width source windows in guard tests.** `SpinSeatCount.test.ts` sliced
900 characters from `tournament_type: 'SPIN'` and failed because I added
comments above the line it checks — against entirely correct code. A test that
breaks when a comment is added is a test people learn to ignore. It now bounds
on `.select()`, where the insert actually ends. **`spinEngineWiring.test.ts` has
the same 1600-character shape and will break the same way eventually.**

**Building the World Hub without disturbing other agents.** WH CLAUDE.md §7
says do not run `npm run build` in the shared tree. A worktree with a
_symlinked_ `node_modules` does not work — Turbopack panics with "Symlink
[project]/node_modules is invalid, it points out of the filesystem root". APFS
clone the directory instead: `cp -Rc ~/Documents/Smarter-Poker-World-Hub/node_modules .`
takes 16 seconds and costs no disk.

Also: `scripts/git-safe-push.sh` runs `git add -A`. The WH tree currently holds
**140 untracked scratch files** from another agent (`check_*.sql`, `fix_*.py`),
so that script would sweep all of it into your commit. Commit explicit paths
from a detached worktree instead.
