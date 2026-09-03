# Handoff — the champion's exit is closed; here is what is left

**Date:** 2026-08-22 · **Repo:** Smarter-Poker-Club-Arena
**Continues:** `.agent/handoffs/2026-08-22-union-reserve-and-shipping-from-cowork.md`

That handoff's §6.1 ("tournament completion card at the end of a spin, for ALL
finishers") is **done** — PR #242, `5056e6438`, CI green, Hetzner engine
deployed. Everything else in its §6 is still open and still accurate. Read it
for the shipping mechanics; §2/§3 there remain the best description of how to
get code out of a Cowork session, with the corrections in §1 below.

---

## 1. WHAT CHANGED ABOUT SHIPPING SINCE THAT DOC WAS WRITTEN

Two things, both from PRs #197–#211 that landed the same day:

**Agents do not merge any more.** `.github/workflows/agent-autopilot.yml` enables
squash auto-merge on every PR server-side and merges it the moment the required
checks go green. Your job ends when the PR exists. Do not run `gh pr merge` at
all — the previous handoff's §2.4 is superseded on this point.

**One worktree per agent, and it is no longer advisory.** Start with:

```bash
eval "$(bash scripts/agent-workspace.sh <your-agent-name> fix/<slug>)"
```

That lands you in `~/Documents/.agent-trees/Smarter-Poker-Club-Arena/<agent>` on
`agent/<agent>/fix/<slug>`, cut from a freshly fetched `origin/main`. Rule 1a of
`.agents/rules/00-anti-regression-workflow.md`. Note the shared clone
`~/Documents/Smarter-Poker-Club-Arena` may be dozens of commits behind, so the
script itself may not exist in it yet — `git show origin/main:scripts/agent-workspace.sh > /tmp/aw.sh`
and run that copy.

Still true and still worth the words:

- `npx tsc --noEmit` reports 5 phantom errors in `src/pages/LeaderboardPage.tsx`
  (`react-virtuoso`) if you symlink the shared clone's stale `node_modules`. The
  package IS in `package.json` and IS installed in CI. Check `package.json`
  before believing tsc about a missing module.
- `host_terminal` dies on sleeps longer than ~140s. Poll in short calls; a
  timed-out call does not kill the shell.
- **Your World Hub sync will very often be `cancelled`**, and that is normal, not
  a failure. `Build for World Hub Sync` runs `cancel-in-progress`, and with three
  to five agents merging, a newer commit supersedes yours within minutes. It
  publishes from `main`, so your work goes out with whichever run survives. Check
  that your commit is an ancestor of `origin/main`, not that your own sync run
  finished.

---

## 2. WHAT #242 FIXED, AND THE SHAPE OF BUG IT WAS

Full write-up in `MIGRATION-CHANGELOG.md` under 2026-08-22. The short version,
because the shape recurs here:

`finishTournament` paid the winner, stamped the row, released the seats, closed
the tables and returned **without broadcasting anything**. TablePage had carried
a winner branch (`position === 1` → celebration overlay → lobby) since the day
the feature shipped, and it was unreachable _by construction_: the only event
that reaches it is `player_eliminated`, and `eliminatePlayer` is never called
with place 1 — both call sites floor at 2 deliberately, so 1st stays reserved
for `finishTournament`.

So: code that compiled, typechecked, read correctly, and had never once
executed. No type checker can see that, and no source-level assertion about
_that file_ can either — the missing thing was in a different file. It is the
same shape as the leaderboard RPC that vanished while its signature survived,
and the same shape as the result card that shipped as router state to a route
whose reader lived one segment deeper.

**The general lesson, which is rule 4 of the anti-regression workflow:** when a
handler exists for an event, assert that the event is _sent_. `tests/config/
tournamentWinnerExit.test.ts` pins both ends and the fact that they still agree
on the name. Six of its nine assertions fail against the previous `main`.

### Dead code found on the way — deliberately left in place

Not touched, because deleting it is its own change and does not belong riding on
a money-adjacent path. Whoever removes it should confirm each one first:

- `src/components/tournament/TournamentResultCard.tsx` and the router-state
  reader in `ClubLobby.tsx` (lines ~112–115, ~485). **Nothing navigates with
  `{ state: { tournamentResult } }` any more** — the app-root
  `TournamentRankingHost` + `pendingSessionSummary` replaced that carrier. The
  live card is `TournamentRankingCard`. Note `TournamentResultCard` is where the
  `isSpin?: boolean` field lives that the previous handoff mentioned; the live
  path has no such flag and does not need one (the split is on the _presence_ of
  `payload.tournament`, which is the point).
- `TournamentService.broadcastWinner` and `.broadcastElimination` — no callers
  anywhere. Real broadcasts come from the engine via `this.broadcast(...)`.

---

## 3. STILL OPEN — from the previous handoff's §6, unchanged

In priority order. Nothing below was touched by #242.

1. **Verify spins are a true 1:1 animation clone of cash games** (§6.2). Never
   audited end to end. Extend the existing `CSS Beat E2E (multi-table +
animations)` job rather than inventing a second mechanism; see
   `.agent/handoffs/2026-08-21-css-beats-e2e-ci-job.md`.
2. **`tests/e2e/hero-card-row.spec.ts` has no vertical assertion** (§6.3). It
   measures `seatTop/seatBottom/rowTop/rowBottom` and asserts only on the
   horizontal axis, so a card row could float off the plate and pass. Pure
   geometry, no server, no login. Note PR #178 (`fix/hero-card-row-assertions`)
   is an open, conflicting branch touching this file — reconcile with it hunk by
   hunk, never `--ours`/`--theirs`.
3. **`VITE_RIVE_RIGS=on` in the same commit as the first `.riv`** (§6.4).
   `tests/unit/riveAvatar.test.tsx` pins both flag states on purpose.
4. **Surface `spin_reserve_wallet` in the union UI** (§6.5). The wallet exists
   and reads 0; `pages/api/club-arena/union-wallet.js` (World Hub) does not
   return it and nothing renders it. Needs the column, a display, and a fund
   control wired to `fn_spin_reserve_wallet_fund`.
5. **Retire the 500x columns — reader first** (§6.6). World Hub
   `pages/api/cron/spin-sweep.js:99` still selects `can_draw_500x` and deploys
   separately. Ship the cron change, wait, _then_ drop the columns.
6. **Three permanently unbooked spins** (§6.7): `dea62e98`, `a374cdd3`,
   `78181713`, all `COMPLETED` with `spin_multiplier = null`, so
   `fn_spin_sweep_unbooked` skips them forever. The draw did not happen for
   three games that actually ran — understand why before it recurs.
7. **`supabase/migrations/20260821_challenge_rerolls.sql` was never applied**
   (§6.8). `fn_reroll_challenge` does not exist in production and nothing calls
   it. Apply it or delete the file; do not leave it.

---

## 4. ONE THING #242 DID NOT PROVE

The engine deployed (`Auto-Deploy Hetzner Engine` completed success on
`5056e6438`) and the code path is pinned by tests, but **nobody has watched a
real Spin end and seen the champion land in the lobby.** CLAUDE.md §11 is
explicit that a workflow going green is not a behavioural verification.

The cheap confirmation, when someone is next in front of a live table: finish a
Spin as the winner and check that the ranking card appears in the lobby after
the ~7s celebration beat. The DB-visible half is already good —
`finishTournament` stamps `status='winner'` and releases seats, and that was
working before this change; what is new is only the telling.
