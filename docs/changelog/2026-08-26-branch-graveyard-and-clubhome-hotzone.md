# 2026-08-26 — the branch graveyard, and where ClubHomePage actually burns

Measured against `origin/main` on 2026-08-26 evening, joined with the open-PR
list at ship time. Raw per-branch data: computed with `git rev-list` /
`git cherry` (patch-equivalence, so a commit recreated under a different SHA by
the GitHub-MCP push path counts as merged — the effect CLAUDE.md §12 documents).

## The census

| bucket                   | count   | meaning                                                    |
| ------------------------ | ------- | ---------------------------------------------------------- |
| total remote branches    | 305     | excl. main + ci-marker                                     |
| MERGED                   | 3       | head is an ancestor of main                                |
| EQUIV                    | 103     | every commit's **patch** already on main under another SHA |
| LIVE                     | 199     | at least one genuinely unmerged patch                      |
| LIVE with an open PR     | 42      | the active queue                                           |
| **LIVE with NO open PR** | **157** | **nothing is tracking these**                              |

**106 branches (34%) are pure deadwood** — their content is on
main, only the SHAs differ. 95 of the EQUIV set are `agent/*` branches: the
GitHub-MCP path recreates content under new SHAs, so the local branch never
matches even though the work landed. Deleting all 106 is safe _by
construction_ (patch-equivalence proven). Not done in this PR — a branch
deletion sweep was disabled once before in this repo
(`delete_dead_branches.sh.DISABLED-2026-08-26`), so that decision stays human.

## The 157 untracked LIVE branches

### 14 sentry-autofix relics (April)

Bot-generated one-commit fixes from 2026-04-20/21, all against code that has
been rewritten since. Recommend: delete without reading.

### 12 July-era branches — the interesting pile

| branch                           | unmerged patches | last commit | subject                                                      |
| -------------------------------- | ---------------- | ----------- | ------------------------------------------------------------ |
| `horse-ai-v2`                    | 5                | 2026-07-23  | fix(engine): HandController - betting-round float live-lock  |
| `horse-ai-v3`                    | 3                | 2026-07-23  | V3 horses 3/3: HorseLogic V3 integration — range-conditioned |
| `horse-ai-v4`                    | 2                | 2026-07-23  | V4 horses 2/2: street-IQ verification — 8 new tests (initiat |
| `horse-ai-v5`                    | 3                | 2026-07-23  | V5 horses 3/3: dynamic hand-reading tests — barrel narrowing |
| `horse-ai-v6`                    | 2                | 2026-07-23  | V6 data integrity 2/2: HandController cent-snapping at all c |
| `horse-ai-v7`                    | 5                | 2026-07-23  | V7 horse AI (5/5): test suite — V7 preflop mastery, size rea |
| `rake-bbj-full-audit-2026-07-24` | 3                | 2026-07-23  | docs(db): RAKE-AUDIT migrations — bbj_percent re-arm (applie |
| `sweep-4-clean`                  | 1                | 2026-07-23  | chore(sweep-4): stage PreciseActionTimer + RakebackSettlerSe |
| `sweep-4-engine-fixes`           | 13               | 2026-07-23  | chore(sweep-4): probe10 (temp)                               |
| `horse-ai-v10`                   | 2                | 2026-07-24  | V10 engine: range-advantage c-bets, SPR pot control, rake-aw |
| `horse-ai-v8`                    | 5                | 2026-07-24  | V8 horse AI (5/5): test suite — hi-lo decomposition, draw qu |
| `horse-ai-v9`                    | 4                | 2026-07-24  | V9 horse AI tests: bet-size families, difficulty-aware tank  |

The `horse-ai-v2…v10` series (2-5 unique patches each) looks like the version
history of the horse AI kept as branches. If `HorseLogic` on main is the final
version, these are history, not work. `sweep-4-engine-fixes` (13 unique
patches, "probe10 (temp)") is the one that most wants a human eye.

### 131 August branches with no PR

| branch                                         | unmerged patches | last commit | subject                                                      |
| ---------------------------------------------- | ---------------- | ----------- | ------------------------------------------------------------ |
| `fix/table-seat-library-avatars`               | 2                | 2026-08-04  | fix: render library avatars at table seats (stop demoting /a |
| `fix/wave1-m6-rakeback-keyset-cursor`          | 11               | 2026-08-06  | chore(m6): settler service                                   |
| `fix/table-visuals-dan-live-e2e`               | 4                | 2026-08-14  | fix(table): bundle TableVisualHotfix.css with the table page |
| `fix/table-visuals-wave3`                      | 2                | 2026-08-14  | fix(table): correct corrupted hex in card-back gradient (#1c |
| `fix/table-freeze-and-dead-actions`            | 4                | 2026-08-15  | fix(server): watchdog uses correct user_id key; mirror deali |
| `harden/final-gaps`                            | 2                | 2026-08-15  | fix(build): commit the five table-skin images — main's clien |
| `harden/never-freeze`                          | 8                | 2026-08-15  | test(engine): freeze regression suite + dropTable subscriber |
| `patch/bounty-pool-payout`                     | 2                | 2026-08-15  | agent-patch: apply bounty-pool-payout.patch                  |
| `patch/bounty-table-celebration`               | 2                | 2026-08-15  | agent-patch: apply bounty-celebration.patch                  |
| `patch/green-test-suite`                       | 3                | 2026-08-15  | agent-patch: process deletes.txt                             |
| `patch/hand-completed-emit`                    | 2                | 2026-08-15  | agent-patch: apply hand-completed-emit.patch                 |
| `patch/lobby-live-pane-v2`                     | 3                | 2026-08-15  | agent-patch: apply lobby-live-pane.patch                     |
| `patch/rebuy-primetime`                        | 2                | 2026-08-15  | agent-patch: apply rebuy-primetime.patch                     |
| `patch/rebuy-rollout-recurring`                | 2                | 2026-08-15  | agent-patch: apply rebuy-rollout.patch                       |
| `patch/share-hand-cash-surface`                | 2                | 2026-08-15  | chore(agent): queue share-hand.patch                         |
| `patch/share-hand-v2`                          | 2                | 2026-08-15  | agent-patch: apply share-hand.patch                          |
| `patch/table-empty-panels`                     | 2                | 2026-08-15  | agent-patch: apply table-panels.patch                        |
| `patch/table-features-throwables-rabbit-share` | 4                | 2026-08-15  | agent-patch: apply table-features.patch                      |
| `patch/tablepage-session-peaks`                | 2                | 2026-08-15  | agent-patch: apply tablepage-session-peaks.patch             |
| `patch/tournament-creation-bounty-split`       | 2                | 2026-08-15  | agent-patch: apply tournament-creation-bounty-split.patch    |
| `patch/tournament-lobby-live-pane`             | 2                | 2026-08-15  | agent-patch: apply lobby-live-pane.patch                     |
| `patch/tournament-moments`                     | 3                | 2026-08-15  | agent-patch: process deletes.txt                             |
| `patch/tournament-stranded-seats`              | 2                | 2026-08-15  | agent-patch: apply tournament-stranded-seats.patch           |
| `security/purge-hardcoded-service-role`        | 11               | 2026-08-15  | security: redact live service_role JWT from CLAUDE_AUDIT_LOG |
| `security/purge-test-account-password`         | 3                | 2026-08-15  | security: purge hardcoded test-account password (audit log)  |
| `patch/assistant-hand-inputs`                  | 2                | 2026-08-16  | agent-patch: apply assistant-hand-inputs.patch               |
| `patch/sitout-css-dead-rules`                  | 2                | 2026-08-16  | agent-patch: apply sitout-css-dead-rules.patch               |
| `patch/sitout-honest-timer`                    | 2                | 2026-08-16  | agent-patch: apply sitout-honest-timer.patch                 |
| `patch/style-icons-letters`                    | 2                | 2026-08-16  | agent-patch: apply style-icons-letters.patch                 |
| `patch/tos-gate-truthful`                      | 2                | 2026-08-16  | agent-patch: apply tos-gate-truthful.patch                   |
| _…and 101 more_                                |                  |             |                                                              |

These are the likeliest real losses — recent work whose PR was merged under a
different SHA (then EQUIV would have caught it), closed without merging, or
never opened. Anything here you recognise as finished should get a PR or an
explicit burial.

## ClubHomePage: where concurrent edits actually pile up

Of 116 recent LIVE branches, **38 touch `ClubHomePage.tsx`** (43 touch
TablePage, 24 GameServer). Hunk-weight per 150-line region (how many concurrent
diff hunks land there — overlap is what turns into merge conflicts):

| region      | hunk-weight | what lives there                                                          |
| ----------- | ----------- | ------------------------------------------------------------------------- |
| **600-899** | **104**     | the data-loading effect: `viewPrefsOwner`, the load watchdog `setTimeout` |
| 1350-1649   | 56          | `matchesThisClub` + realtime subscription handlers                        |
| 2250-2549   | 55          | render: header/wallet cards                                               |
| 1050-1349   | 43          | more loaders                                                              |

The file is 4,353 lines. **The 300 lines from 600-899 carry a quarter of all
concurrent edit pressure.** If one extraction is done to relieve the #1
conflict hotspot in the repo, it is that block — the club-home data loader —
into its own module. That is a surgical cut, not the full decomposition, and it
moves the most-contended lines into a file small enough for git to merge
cleanly.

## Recommended order

1. Human decision: delete the 106 proven-deadwood branches + 14 sentry
   relics (one `git push origin --delete` batch; list is in
   `_agent_tmp/branch-analysis.tsv` buckets MERGED/EQUIV).
2. Triage the 12 July branches — 30 minutes of reading, possibly real work.
3. Extract the ClubHomePage 600-899 loader block — the single highest-leverage
   refactor per conflict relieved, far cheaper than full decomposition.
