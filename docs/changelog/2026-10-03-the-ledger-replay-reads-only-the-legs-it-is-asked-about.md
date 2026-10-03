# The ledger replay reads only the legs it is asked about (2026-10-03)

Phase 5 of 9 (a check nobody can read is not a check). Two migrations:

- `20261003112214_the_journal_can_be_read_for_the_accounts_that_ask` declares the entity reader. Live as schema_migrations `20261003112324`; the recorded statements are byte-identical to the repo file.
- `20261003112219_the_ledger_replay_reads_only_the_legs_it_is_asked_about` points the replay at it. Not yet applied: see Status below.

## What was wrong

`ca-ledger-replay-nightly` runs `fn_ca_ledger_replay` at 06:40 UTC. It is the nightly proof that every wallet, treasury, pool and the felt moved exactly as the journal says, and it is what trips the kill switch when one did not. Its run time, from `cron.job_run_details`:

| night | result                                                         |
| ----- | -------------------------------------------------------------- |
| 09-26 | 323 s                                                          |
| 09-27 | 500 s                                                          |
| 09-28 | 473 s                                                          |
| 09-29 | 500 s                                                          |
| 09-30 | 400 s                                                          |
| 10-01 | 627 s                                                          |
| 10-02 | never started ("job startup timeout")                          |
| 10-03 | cancelled at 600 s, inside `fn_ca_leg_accounts_since_snapshot` |

So the books went two nights without a verdict, and every night an idle account keeps an older reading, so the read only grows.

The replay groups the accounts it touched by the reading each was last judged at. For each group it asked `fn_ca_leg_accounts_since_snapshot` for every leg in the journal since that reading. Almost every account was read the night before, but an account that sat idle keeps its own old reading and forms its own group. On 10-03 the touched accounts held five readings besides the 10-01 one (09-23, 09-27, two on 09-29, 09-30). Each of those read the whole journal from its own date, about 27 extra days in all at 558,016 legs a day, to explain 65 accounts. A single 2.2-day read takes 71 s.

## What changed

- `fn_ca_leg_accounts_since_snapshot_for(prev_at, snapshot, entities)` is `fn_ca_leg_accounts_since_snapshot` with one change: each side of a leg is read only for the given entities, through the entity indexes. Same visibility rule, same keying, same doors.
- `fn_ca_ledger_replay` gives each group its owners, plus the wallet row ids of any union among them, because a union wallet's legs may carry either id.
- The felt (`table_stack`) is one account owned by no entity, so the group that holds it keeps the full reader. That group is the one read the night before, the shortest window there is.

Nothing else in the replay changes: the same accounts, the same balances, the same judgement, the same incidents and the same kill switch.

## Evidence (production, 2026-10-03, rolled back)

- Under one REPEATABLE READ snapshot, over all 1,023 accounts the replay has ever read, the entity reader and the full reader agree on every account: 907 with legs, 187,515 legs, every account type including `union_bank` and `union_wallet`. The entity reader took 3.8 s against 6.7 s for the same window.
- The five stale groups of 10-03 read in 1.1 s together, against an estimated 860 s for the full reader (27 days at the measured 71 s per 2.2 days).
- The first migration repeated that comparison over the last hour, in one statement, before it committed.

No job is added or rescheduled. Nothing is backfilled. No chips move.

Pinned by `tests/the-ledger-replay-reads-only-the-legs-it-is-asked-about.law.test.ts`.

## Status

The second migration was offered to the Supabase MCP `apply_migration` four times on 2026-10-03 (11:03 to 11:30 UTC). Each call timed out at 180 s and wrote nothing: the replay still reads `d64b8e6e...` and no history row exists. The first migration, which has no `DROP` in it, applied at once. The replay body contains `DROP TABLE IF EXISTS` for its own temp scratch tables, and the tool asks a person to confirm destructive statements. The working explanation is that this confirmation is the wait. It applies unchanged once that confirmation is given, or through `apply-merged-migration.yml` after merge. Until then the 06:40 run reads the whole window for every group, as before.
