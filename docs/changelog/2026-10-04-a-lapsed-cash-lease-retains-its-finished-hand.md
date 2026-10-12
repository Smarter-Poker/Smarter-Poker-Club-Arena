# A lapsed cash lease still retains its finished hand (2026-10-04)

## What happened

2026-10-03 23:43 UTC, 85 cash hands on 85 tables were refused by the atomic
settlement contract with `atomic hand commit refused (lease_proof_expired)`.
The open alerts were 43 `ServerTableEngine.authoritative_hand_semantic_refusal`,
55 `postHandTasks.hand_history_failed` and 2 `postHandTasks.leave_pending_failed`
(warning, `supabase_timeout`). The drift incident
`fn_ca_conservation_sweep:fn_ca_hand_commit_refusals` (738b39d2) kept re-raising
on them.

### The trigger was a database host stall, not the engine

- `hand_atomic_commits` recorded nothing from 23:43:07 to 23:43:45. The normal
  rate is 15-30 commits a second.
- Edge requests that completed between 23:43:12 and 23:43:28 had waited 23-32 s
  inside Postgres. That included browser reads such as `club_members` and
  `get_my_full_profile`, so the whole database was stalled, not only the
  engine's own calls.
- Postgres logged almost nothing between 23:43:15 and 23:43:41. At 23:43:41 it
  logged parallel workers failing with "could not attach to dynamic shared
  area".
- This was the start of the memory exhaustion that stopped Postgres at
  23:44:27. See `2026-10-03-the-database-keeps-memory-headroom.md`. The compute
  was moved to 4XL at 00:06.
- It was not a cutover: the 23:05 engine release cut over at 23:55. It was not
  the break either, which runs :53-:00.
- The engine's own diagnostics show that the last renewal to come back `kept`
  was sent at about 23:43:09. The first proof expired at 23:43:29.

The earlier bursts of this incident had other causes, and each was fixed in its
own PR:

| Burst | Cause | Fix |
|---|---|---|
| 2026-10-01 and 10-02 | PostgREST pool stalls | the heartbeat got its own login (#5874) |
| 10-03 00:53 | WAL flush | the renewal no longer waits for the disk (#5901) |
| 10-03 09:34 | a pinned xmin with MultiXact chains | #5952, #5963 |

The common shape is that any database stall longer than the 30 s stale window
fences every generation.

### Why hands were lost

- All 85 hands had finished and were inside their settlement when their proofs
  lapsed.
- 30 had already been retained in `smarter_private.hand_submissions`. Their
  successors settled them through `fn_ca_resume_hand_submission`, and their
  alerts closed on the exact original receipt.
- The other 55 were refused before retention. In 54 cases the local proof
  refused them. In one case (table 19e033d0, #22120571) the database refused
  them, at the heartbeat-age check in `fn_ca_retain_hand_submission`. With
  nothing retained, the successor disposed the hand.
- All 55 are in `hand_submission_dispositions` as `disposed`, with no
  submission and no commit.
- No chips moved. Every seat kept its pre-hand stack. What players lost was a
  hand they had already watched finish.

## The fix

Retention moves no money. It stores the exact request. The successor's door
then settles that request under its own fresh lease, after it proves three
things under the table's locks:

- the original never settled the hand;
- the lease names the successor and not the original;
- every chair, before-stack and hand number is unchanged.

Changes:

- **Engine.** In `server/src/services/supabase/handHistory.ts`, a writer whose
  `assertLeaseAuthority` refuses with `lease_proof_expired` now retains the
  exact original under its own generation, and only then refuses
  (`retainLapsedOriginalForSuccessor`). This applies when
  `retainWhenLeaseLapses` is set and nothing was retained yet. The retention
  uses the same identical-request budget as the commit. The refusal message
  says what happened, for example `...; original retained for the successor`.
  The generation is still terminated, and the original still never commits.
- **Engine.** `ServerTableEngineSettlement.postHandTasks` sets the flag for
  verified cash generations. It also drops its own pre-call proof check,
  because the writer now judges a lapse before its first request.
- **Database.** Migration `20261004201926` changes `fn_ca_retain_hand_submission`
  for cash tables only: retention no longer requires a fresh heartbeat. The
  lease row must still name the exact instance, generation and protocol.
  - A lease that was taken, released or re-claimed still refuses with
    `HAND_SUBMISSION_LEASE_UNPROVEN`.
  - A disposed hand still refuses with `PERMIT_DISPOSED`.
  - A tournament retention still requires a fresh heartbeat.
- **Ordering.** `stop()` joins the in-flight settlement with no timeout before
  `GameServer` releases the lease and the successor claims it. So the original
  retains before its successor reads the table.

### Verified before merge

The live function text (md5 `02a6c278…`) was replayed on PGlite (PostgreSQL 16)
with stub tables. The migration installs md5 `20fdb0a1…`, and a second run is a
no-op. These cases hold:

| Case | Result |
|---|---|
| cash, fresh lease | retained |
| cash, stale 40 s (the 23:43 case) | retained |
| cash, stale 3600 s | retained |
| cash, re-claimed generation | refused |
| cash, other instance | refused |
| cash, released lease | refused |
| tournament, fresh lease | retained |
| tournament, stale 40 s | refused |
| cash, already disposed | refused |

Without the migration, the stale cash cases are refused, as they were on
2026-10-03.

## What this does not cover

- **Tournament hands.** The manager's data fence and the F06 permits decide
  that path. A lapsed tournament manager is refused at PostgREST before any
  function runs (`TOURNAMENT_MANAGER_FENCED`). The 23:43 hands were all cash.
- **A hand still being played when the proof lapses.** That generation is
  stopped mid-hand. Nothing was decided, and the hand is voided at its pre-hand
  stacks as before.
- **A chair that changed between the stall and the successor's start.** This is
  rare, because the window is the few hundred milliseconds between the database
  answering again and the successor's start. When it happens, the retained hand
  meets the door's existing standing refusal (`HANDOFF_STATE_CHANGED`), exactly
  as a hand retained before a failure already does.
