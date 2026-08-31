# 2026-08-31 — Pull Request Backlog Triage

## The finding

120 open pull requests, 95 of them opened by `agent-autopilot` in one burst on
2026-08-26. Every one CONFLICTING and 800-1,100 commits behind `main`.

The intuitive reading — "a hundred finished fixes are one click from shipping"
— is **wrong**, and acting on it would have been the expensive mistake.

This repo ships through two paths. `git push` moves the commit object; the
GitHub-MCP path (`push_files`) **re-creates the same content under a different
SHA**. `CLAUDE.md` section 12 already documents this as why `git pull --rebase`
strands the shared clone. It has a second consequence nobody had measured: a
pull request whose content landed by the other path **stays open forever**,
looking like unshipped work, because git sees no relationship between the two
commits.

## Measured, not assumed

`scripts/dev/pr-supersession-scan.py` samples up to 40 substantive added lines
per PR (>25 chars, comment openers excluded, deduplicated) and asks how many
appear verbatim in the current `main` checkout.

| Already on main                  | PRs    |
| -------------------------------- | ------ |
| 100% (plus 4 with an empty diff) | **22** |
| 80-99%                           | 29     |
| 50-79%                           | 14     |
| 20-49%                           | 12     |
| 0-19% — genuinely unshipped      | **44** |

A fifth of the backlog was residue.

## Action taken

**20 pull requests closed**, each with its evidence in the closing comment:

- **19 superseded** — 100% of sampled lines already on `main`.
- **1 exact duplicate** — #2040 and #2045 were opened five minutes apart from
  different `auto/*` branches with **byte-identical diffs**
  (`4eaa80c9…`). All 98 open PRs were hashed; this was the only duplicate pair,
  so the backlog is not broadly affected.

Nothing was destroyed: branches and commits remain, and every PR can be
reopened.

### Why closing them was a fix, not tidying

`agent-autopilot` had squash **auto-merge ARMED on every one of them** (open
issue #375 describes the mechanism). They only failed to merge because they
conflict. Had any conflict ever been resolved mechanically, content 800-1,100
commits stale would have auto-merged over `main`. Closing removes that hazard.

Three PRs scoring 100% were **deliberately left open** — #2101, #2100, #2067
were created within the last 20 minutes with auto-merge armed and are another
agent's live work. A high score there almost certainly means a sibling PR just
landed the same content, not that the work is dead.

## Verification of the method

The scan is a triage instrument, not an oracle, so every closure was spot-checked:

- **#1149** — independently confirmed `AvatarCosmetics.tsx` exists on `main` and
  `equippedFrame` is consumed in three files.
- **#1014** — read the diff: its entire content is a **duplicate import** of a
  line already two lines above it. Merging it would have been a defect.
- **#1131**, **#1928** — sampled added lines checked individually against `main`.

## What remains: 44 PRs with real unshipped work

Listed below by supersession score (lowest = most genuinely new). These need a
per-PR decision, and they cannot simply be merged — each is ~800-1,100 commits
behind, so landing one means re-applying its intent to today's code, not
resolving a conflict.

| PR    | Date       | Files | +/-         | On main | Title                                                                  |
| ----- | ---------- | ----- | ----------- | ------- | ---------------------------------------------------------------------- |
| #1021 | 2026-08-26 | 8     | +486/-13    | 0%      | agent/cowork seatstart/fix/seat first games that can never reach three |
| #1022 | 2026-08-26 | 5     | +57/-23     | 0%      | agent/cowork npmforce/fix/npm force disabled protections everywhere    |
| #1027 | 2026-08-26 | 8     | +346/-19    | 0%      | agent/cowork identity/fix/an unattributable commit cannot deploy       |
| #1034 | 2026-08-26 | 3     | +41/-19     | 0%      | agent/cowork openpr/perf/open a pr once per branch not once per push   |
| #1046 | 2026-08-26 | 15    | +314/-538   | 0%      | agent/cowork claude wallets/perf/dedupe gate r2                        |
| #1051 | 2026-08-26 | 7     | +264/-9     | 0%      | fix(share): the variant map was wrong twice, and the discard street wa |
| #1053 | 2026-08-26 | 8     | +974/-12    | 0%      | fix(spin): six findings from reading my own wallet back as an attacker |
| #1054 | 2026-08-26 | 2     | +54/-0      | 0%      | docs: pushing is enough, and an agent wrote a .command file anyway     |
| #1055 | 2026-08-26 | 22    | +249/-3356  | 0%      | fix(hand-history): the type said 'all-in' and nothing ever said 'all-i |
| #1069 | 2026-08-26 | 1     | +106/-0     | 0%      | docs(perf): record phases 5-6 - what measuring the bundle and auditing |
| #1075 | 2026-08-26 | 4     | +121/-0     | 0%      | fix(clones): one clone per repo, for every agent and the dev server    |
| #1077 | 2026-08-26 | 2     | +40/-22     | 0%      | fix(workspace): give each worktree its own node_modules, not a symlink |
| #1091 | 2026-08-26 | 5     | +140/-21    | 0%      | fix(ca): PLO was deciding inside its own noise, and three dead code pa |
| #1092 | 2026-08-26 | 1     | +71/-4      | 0%      | perf(ci): run only the checks the diff can actually break              |
| #1124 | 2026-08-26 | 1     | +128/-0     | 0%      | docs(changelog): anon wallet exposure, the PUBLIC-grant trap, and what |
| #1134 | 2026-08-26 | 1     | +91/-99     | 0%      | docs(rules): make the agent rules binding, not advisory                |
| #1145 | 2026-08-26 | 1     | +171/-0     | 0%      | docs(handoff): what four rounds of table work did not finish           |
| #1176 | 2026-08-26 | 21    | +1497/-2572 | 0%      | agent/cowork lobby/stop mtt card flicker                               |
| #1439 | 2026-08-27 | 18    | +854/-325   | 0%      | fix(tournaments): phase 3 - the add-on break stops the clock, and Star |
| #1511 | 2026-08-27 | 27    | +1648/-466  | 0%      | fix(mobile): round 3 - card sizes, header chrome, stale winner band, 3 |
| #1742 | 2026-08-29 | 5     | +690/-1     | 0%      | fix(money): overlays fund from the union bank, and a refused guarantee |
| #1930 | 2026-08-30 | 3     | +342/-0     | 0%      | fix(engine): reopen 71 live tournament tables the legacy engine closed |
| #2040 | 2026-08-31 | 13    | +879/-85    | 0%      | fix(roster): recover live player command reads                         |
| #2045 | 2026-08-31 | 13    | +879/-85    | 0%      | fix(roster): recover live player command reads                         |
| #2096 | 2026-08-31 | 1     | +6/-3       | 0%      | fix(stats): recover owner-only production contract                     |
| #1059 | 2026-08-26 | 2     | +83/-6      | 2%      | fix(engine): the fee rollup loop could never complete a single batch   |
| #1127 | 2026-08-26 | 7     | +437/-3     | 2%      | feat(spin): the Spins wallet, and it disappears when a club joins a un |
| #1181 | 2026-08-26 | 3     | +207/-9     | 2%      | agent/cowork addon leak/fix/markseatasleft destroys stack on throw     |
| #1211 | 2026-08-26 | 5     | +1073/-0    | 2%      | fix(db): reclaim hand_history empty pages and stop the profit reconcil |
| #2102 | 2026-08-31 | 6     | +148/-8     | 2%      | fix(table): the seat bound and the seat rings are one number (phase 1  |
| #1966 | 2026-08-30 | 12    | +856/-86    | 5%      | fix(roster): recover live player command reads                         |
| #1972 | 2026-08-30 | 42    | +4000/-332  | 5%      | fix(ui): rebuild tournament lobby as reference machine                 |
| #1032 | 2026-08-26 | 19    | +1767/-704  | 7%      | agent/swarm cosmetics cards/fix/card backs and felts                   |
| #1087 | 2026-08-26 | 8     | +860/-160   | 7%      | fix(replay): the query was fixed and the mapping was not - every field |
| #2061 | 2026-08-31 | 2     | +67/-1      | 7%      | fix(pineapple): the picker belongs to the table you are looking at, an |
| #1015 | 2026-08-26 | 15    | +634/-134   | 10%     | feat(spin): an owner who activates gets their own board                |
| #1110 | 2026-08-26 | 3     | +320/-50    | 10%     | fix(registration): stop reporting unverified outcomes as success       |
| #1143 | 2026-08-26 | 3     | +428/-73    | 10%     | fix(club): add toast on description save and fix union_id missing on u |
| #1669 | 2026-08-28 | 4     | +109/-10    | 10%     | feature/sit out and evictions                                          |
| #1058 | 2026-08-26 | 6     | +1060/-6    | 12%     | feat(spin): a wallet that belongs to somebody, and a seed that comes b |
| #2103 | 2026-08-31 | 3     | +101/-2     | 12%     | fix(waitlist): the other two writers did not know the index had widene |
| #1043 | 2026-08-26 | 11    | +1389/-94   | 15%     | agent/cowork claude bankops/feat/claim back promo send                 |
| #1105 | 2026-08-26 | 3     | +482/-0     | 17%     | fix(claim-back): a retried claim charged twice, and a super agent coul |
| #2074 | 2026-08-31 | 10    | +614/-32    | 17%     | feat(pineapple): the discard clock is the server's, per seat, and it c |

## Recommended sequence for those 44

1. **Docs-only PRs** (#1145, #1134, #1124, #1069, #1054) — no code risk;
   land or close on read.
2. **Money paths first** among the rest — #1742 (overlays funding from the
   union bank), #1105 (a retried claim charged twice), #1053 (spin wallet
   findings), #1058/#1127 (the Spins wallet). These are the ones where staying
   unshipped has an ongoing cost.
3. **#1930** — reopens 71 live tournament tables the legacy path left closed.
4. Everything else by size, smallest first.

## The systemic issue underneath

The backlog regenerates because `agent-autopilot` opens a PR per branch and
arms auto-merge, while the MCP push path lands the same content separately.
Until those two paths agree, every future burst leaves the same residue. Issue
#375 tracks the autopilot half.
