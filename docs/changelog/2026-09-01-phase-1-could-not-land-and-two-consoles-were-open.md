# Phase 1 could not land, and two operator consoles were answering browsers

2026-09-01. Continuation of the Spins audit. Phase 1's database and
monitoring work was already live; its pull request was not.

## What was actually blocking it

PR #2341 carried the second half of Phase 1 -- the Spin back-pay timeout fix,
the restored `turn_relay` scrape job, and the deploy-reason correction. It had
auto-merge armed since 20:19 UTC the previous evening and had not landed. The
previous session recorded the cause as "GitHub Actions is failing every job on
every branch". That was true when it was written and is not true now: Actions
is healthy, and the pull request was simply `CONFLICTING / DIRTY` against a
`main` that had moved 40 commits.

The conflict was in the three generated Supabase manifests and nothing else.
They are regenerated from the live database by several agents, so a branch that
carries its own copy re-conflicts every time `main` moves -- which is what had
happened, twice, while this was being fixed. Resolved by taking `main`'s copies
verbatim after verifying object by object that every table, column and function
this branch created is already in them. The branch no longer touches those
files.

## Three defects found while getting it to land

**Main was red on a timeout, not a finding.**
`tests/unit/theCopyRulesReachTheEngineAndTheDatabase.test.ts` spawns
`check-title-case.mjs`, which walks `src/` and `server/src/`. Standalone that is
~2s. Run alongside the other 40 files in its suite it measured 6.3s against
vitest's 5s default, so the pin failed on a machine that was merely busy. The
work is real and bounded, so the spawn was given an explicit 60s budget rather
than the checker being trimmed to fit.

**`fn_ca_unledgered_insert_paths` was answering any browser.** It enumerates
every table whose insert path is not covered by a ledger trigger -- a map of
where money can move without being written down. It was `SECURITY DEFINER`,
took no identity argument, and `anon` and `authenticated` could execute it. It
appeared in production between 11:33 and 12:17 UTC and the Telemetry Exposure
gate caught it on the next branch that ran. Revoked to `service_role`.

**`fn_detect_results_without_a_hand` was answering any logged-in browser**, an
hour later, by the same mechanism: the migration wrote `GRANT EXECUTE ... TO
service_role` and no `REVOKE`, so `PUBLIC` kept the default grant every new
function is created with and `authenticated` inherited it. Granting the role you
want does not take it away from everyone else. Only the engine calls it.
Revoked.

Both were applied to production first and are recorded here as migrations, per
the house rule that the repo carries the record of what was applied.

## Phase 1 verified against production, not against its own report

| Claim                        | Verified                                                                                                                                                                                  |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fairness view live           | `v_spin_draw_fairness`: 20,576 draws over 7d, realised 2.755929 vs spec 2.763773, z = -0.69, 0 constrained, no drift                                                                      |
| Gauges on the engine         | 18 `poker_spin_*` series on `/metrics`, exactly the 18 `SpinMetrics.ts` defines, freshness 49s                                                                                            |
| Alert rules loaded           | 8 spin rules across `spin-fairness`, `spin-money`, `spin-experience`, all health `ok` on engine-01                                                                                        |
| `turn_relay` restored        | Scrape job present and `up`                                                                                                                                                               |
| Back-pay no longer times out | Dry run returns in 2.1s, `ok: true`, 0 owed                                                                                                                                               |
| Rake attribution             | 1,191 of 1,191 settlements in the last 6h attributed; gap view 0; queue 0; no error-stamped rows                                                                                          |
| Copy rules                   | All four source checkers pass; `fn_ca_banned_copy_characters()` returns 0 rows on live data; the shipped bundle's only em dash is inside the character class of the code that strips them |

## The one open item, measured again

Reveal lag is load-shaped, not a runaway. Over the last twelve hours, by hour
UTC: p50 was 918ms at 06:00 and 1,047ms at 07:00 -- better than the ~3s round 18
shipped for -- and 4,657ms and 4,757ms at 10:00 and 11:00, with p90 reaching
12.2s. It tracks concurrency rather than climbing, which points at contention in
the start path rather than a fixed regression. `SpinRevealChronicallyLate` fires
at p50 > 5000ms for 15m, so the worst hour today sat just under its line.
