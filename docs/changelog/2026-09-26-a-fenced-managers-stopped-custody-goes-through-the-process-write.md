# A Fenced Manager's Stopped Custody Goes Through The Process Write

2026-09-26. Migration `20260926131014` (applied to production 13:14Z, recorded
with the file's exact bytes). Law
`tests/a-fenced-managers-stopped-custody-goes-through-the-process-write.law.test.ts`.

## The stall

No engine release shipped after 09:08Z (`cd5892e8`). Deploy attempts #712 to
#716 (`39418cb5`, `243b0318`, `906883eb`, `66408d35`, `3956bc0b`) all ended
"the durable Hetzner release transaction did not complete".

The run logs read like a timing fault: "the durable table break has 259800ms
remaining, below the 260000ms candidate-and-recovery budget", then the same
line every 15 seconds down to 0ms, then "the engine did not present a restart
certificate with enough proof time remaining". It was not a timing fault.
`maintenance_certificate` checks the remaining time before readiness, so a
certificate that is shut for the whole break is only ever reported as "below
the budget" once the countdown passes 260000ms. Nothing in the log named the
shut certificate.

What was actually true, from production:

| evidence                                                    | reading                                                                                                   |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `engine_maintenance_break_log`, 09:55Z to 12:55Z (5 breaks) | `unparked_at_countdown = 630`, `ready_for_restart_at` null every time                                     |
| `/health` on `cd5892e8`                                     | `stopped_bank_custody_stuck: 629`, `breaksSinceRestartCertified: 5`, `tournamentManagersQuarantined: 473` |
| edge logs, 12:53Z announcement fan-out                      | 758 `POST /rest/v1/engine_presence_parked` answered 403                                                   |
| postgres logs                                               | ~1,700 `TOURNAMENT_MANAGER_FENCED` a minute                                                               |
| `engine_tournament_leases`                                  | 438 of 565 leases stale                                                                                   |

This is the collapse #5323 describes, on the engine serving now. `cd5892e8`
predates #5323: its terminal engines write stopped time-bank custody with
`savePresenceAtPark`, a POST upsert under the dead manager's data-actor
headers, and `fn_smarter_data_api_pre_request` fences it. The bank never
reaches disk, the census reports `stopped_bank_custody_stuck`, and the
certificate refuses it in every break, by design (#5288). The fix, #5323
(`3956bc0b`), can only arrive through a cutover that the certificate refuses.
Each hour the release waited, fenced, and died.

The certificate was right to refuse. A time bank that is not on disk is still
a bank at stake, and the release script's allow-list may never admit a custody
reason. The fix had to make the write land.

## The fix

The database half of #5323, for the engine that is serving. The old engine
already retries this write at every :53 fan-out. It now lands through the
refusing function #5323 installed (`fn_park_stopped_time_bank_custody`,
migration 20260926090846), and nothing else changes:

1. **The request hook admits one shape past the fence.** Where it would raise
   `TOURNAMENT_MANAGER_FENCED`, a `POST` to `engine_presence_parked` is let
   through under a marker of its own, `fenced-manager-stopped-custody`. It is
   never admitted as a manager. Reads, PATCH, DELETE, RPCs and every other
   path are fenced exactly as before.
2. **A BEFORE INSERT trigger on `engine_presence_parked`**
   (`smarter_private.fn_fenced_manager_stopped_custody_park`) acts only on that
   marker:
   - A row that is not stopped custody (engine instance
     `<instance>:stopped_custody`, a version-1 `time_bank_snapshot` with an
     integral `handNumber` and a `players` object) gets the same
     `TOURNAMENT_MANAGER_FENCED`. The ordinary announcement upsert, which
     writes a null snapshot, is refused as it always was.
   - Stopped custody is written by `fn_park_stopped_time_bank_custody` as the
     `service` actor, with the header's tournament and generation. It refuses
     by name over a later hand, a newer park, an adopted or open mixed F06
     transfer, a table outside the tournament, and a busy transfer lock.
   - On `ok` the raw upsert is suppressed (`RETURN NULL`), so the row on disk
     is the function's, never `ON CONFLICT DO UPDATE`'s. On any refusal the
     trigger raises, the old engine's save returns false, and it records no
     acknowledgement. That table keeps the certificate shut.

`cd5892e8` sets `acknowledgedTimeBankPark` only on a confirmed write, and that
is the only thing that clears `hasUnretiredStoppedTimeBankCustody()`. So the
certificate opens for exactly the tables whose bank is now on disk, under the
rules the fixed engine applies, and for no other. The census, the certificate,
the release script's ladder and its allow-list are untouched.

Proved before the apply on a local PostgreSQL 17 with the live definitions of
the hook and `fn_park_stopped_time_bank_custody`: a dead-generation custody
POST is written by the function (new row, and an older row updated); a null
snapshot is fenced; `newer_park`, `hand_after_custody` and
`table_not_in_tournament` are refused and raised; GET and PATCH are fenced; a
live manager's ordinary upsert and an unmarked insert are untouched.

## The release log names a shut certificate

`maintenance_certificate` now also writes "the restart certificate is also
shut: unparkedTables=... unparkedReasons=..." to stderr when it answers
"below the budget" for a certificate that is not ready. The verdict on stdout
and the exit code are unchanged. The next stall of this shape will read as
what it is.

## What remains

- The load-side cause #5323 names is unchanged: `ENGINE_PG_LISTEN_URL` is not
  set, so lease heartbeats share the PostgREST pool with game traffic. That is
  an owner-held credential.
- Once #5323 is serving, the trigger is inert for new custody (the fixed engine
  writes as `service`). It stays as the narrow path for any older engine.

## Record note

The first apply at 13:14Z revoked the trigger function from `PUBLIC` and from
`anon, authenticated, service_role` in two statements.
`tests/a-revoke-from-anon-must-name-public.law.test.ts` requires one list that
names `PUBLIC`, so the file now does that. The single statement was executed on
production (a no-op, same ACL `{postgres=X/postgres}`), and the history row was
re-recorded with the file's exact bytes (md5 `cebc8f96d9af8358005802b7858ec8f4`).
