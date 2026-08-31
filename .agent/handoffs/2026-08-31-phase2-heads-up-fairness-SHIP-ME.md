# PHASE 2 OF 7 -- HEADS-UP FAIRNESS -- BUILT, TESTED, NOT SHIPPED

Branch: `phase2/heads-up-fairness` · commit `565c513023` · base `origin/main` d3b91a2352
Worktree: `~/Documents/club-arena/.agent-trees/phase2-hu-fairness`

The session that built this had NO network egress: `github.com:22`, `api.github.com`
and `smarter.poker` were all unreachable, `gh` is not installed in that shell, and the
GitHub MCP returns `Bad credentials`. So the work is committed locally and nothing was
pushed. Everything below was run and read; nothing is assumed.

## Ship it

```bash
cd ~/Documents/club-arena/.agent-trees/phase2-hu-fairness
git push -u origin phase2/heads-up-fairness
gh pr create --base main --head phase2/heads-up-fairness \
  --title "Phase 2: fairness in the hand -- heads-up button, dead button, resume clock" \
  --body-file .agent/handoffs/2026-08-31-phase2-heads-up-fairness-SHIP-ME.md
gh pr merge --squash --auto
```

Club Arena reaches production in two hops: CA main -> `build-for-world-hub.yml` ->
a `chore(club-arena): sync build <sha>` commit in the World Hub -> Vercel.

## What changed (7 files, +148 in the three engine files)

| File                                              | Change                                                                                                                       |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `server/src/engine/headsUpButton.ts`              | NEW. Pure seat arithmetic: `drawFirstButtonSeat`, `headsUpButtonSeat`, `nextOccupiedSeat`.                                   |
| `server/src/engine/ServerTableEngineDealing.ts`   | Draws + persists the first heads-up button; derives the heads-up button from the last big blind; records `lastBigBlindSeat`. |
| `server/src/engine/ServerTableEngineBase.ts`      | New `lastBigBlindSeat` field, restored from `hand_history` in the same read that restores the button.                        |
| `server/src/tournament/TournamentManagerBase.ts`  | `resume()` reads the level through `resolveBlindLevel`.                                                                      |
| `server/src/engine/HeadsUpButtonFairness.test.ts` | NEW, 14 tests.                                                                                                               |
| `server/src/tournament/ResumeBlindClock.test.ts`  | NEW, 3 tests.                                                                                                                |
| `server/src/engine/RestartFidelity.test.ts`       | Existing select pin widened to `select('button_seat, players')`, deliberately, with the reason in the test.                  |

## The three defects, measured in production before the fix

**2.1 The heads-up first button was never randomised.** The Spin draws its first
button in `scheduleSpinPostReveal`; a 2-max SNG never reaches that path and fell
through to `buttonSeats[0]` -- the lowest occupied seat. Seating is seat-first, so the
low seat is whoever arrived first, and heads-up the button IS the small blind.

    first hands of 2-max SNG tables, last 6 hours, by button seat:
      seat 1 ... 279
      (no other seat, at all)

**2.2 One player posted the big blind twice when a 3-handed table went heads-up.**
The button rotated forward; TDA Rule 33 says the blinds advance and the button
follows.

    3-handed -> heads-up transitions, last 45 minutes:  86
    of those, the same seat posted the big blind twice: 15  (17.4%)

**2.3 `resume()` read the blind level by array index** -- the one caller that ignored
`resolveBlindLevel`'s own closing instruction. Past the end of a 10-12 row ladder the
index is `undefined` and the `|| blindStructure[0]` fallback armed the level clock with
LEVEL ONE's duration on every restart of a deep game.

## Verification already done

- `tsc --noEmit` on `server/tsconfig.json`: clean.
- 995 tests green across every suite that reads the three changed files:
  521 (engine button/restart/arrival + all of `src/tournament`), 102 (engine sit-out,
  ante, pacing, RIT, guarantee), 130 + 242 (client-side pins incl.
  `noFixedSizeSourceWindows`, `engineSelectIsTheContract`, `tournamentRestartSurvival`,
  `horsesAreTreatedIdentically`, `handCompletionLaw`, `shipped-invariants`).
- The new specs were run against `origin/main`'s copies of the three files: **7 of 17
  fail** there and pass here.
- `noUnhandledRejections` passes over the new fire-and-forget persist.
- Prettier clean; no emoji.

## Prove it live once it publishes

Re-run the 2.1 query above on games created AFTER the sync build lands. The button seat
must stop being 279/279 on seat 1 and split roughly evenly. Re-run the 2.2 query: the
`big_blind_posted_twice` count must go to 0.

```sql
-- 2.1, windowed to after the deploy
with duels as (select id from tournaments
               where tournament_type='SNG' and max_players=2 and created_at > TIMESTAMP 'DEPLOY_TIME'),
first_hand as (select distinct on (h.table_id) h.table_id, h.button_seat,
                      (select count(*) from jsonb_array_elements(h.players)) as seats_dealt
               from hand_history h join duels d on d.id=h.tournament_id
               order by h.table_id, h.hand_number asc)
select button_seat, count(*) from first_hand where seats_dealt=2 group by 1 order by 1;
```

## What I did NOT do, and why

- Did not push, open a PR, merge, or verify anything over HTTP -- no egress (above).
- Did not run the FULL server suite. Each shell call on that machine is capped at ~175s
  and background processes do not survive it; `ChipConservation.property` alone is 11s
  and the whole `src/engine` directory exceeded the cap. I ran every suite that reads
  the changed files instead, plus all of `src/tournament`. CI will run the rest.
- Did not touch the Spin's own draw. It already draws and persists correctly; the new
  code stands down whenever a drawn button is present.
- Did not add a `headsUpSpec.ts`. That is Phase 3.
- The engine's `predictButtonSeat` (the wait-for-BB gate) still predicts the LOW seat
  for the very first hand of a two-handed table, because the draw happens at deal time.
  It is a prediction used to hold a joiner out for one hand, not the button itself, and
  a table starting 2-handed has no joiner to hold out -- but it is a known, deliberate
  inconsistency and Phase 3 is the place to unify it.
