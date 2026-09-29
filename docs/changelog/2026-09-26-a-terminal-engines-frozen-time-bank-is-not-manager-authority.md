# A terminal engine's frozen time bank is not manager authority

2026-09-26. Migration `20260926090846` (applied to production 09:19Z). Law
`server/src/tournament/aTerminalBankIsNotManagerAuthority.law.test.ts`.

## The collapse

The engine collapsed about an hour after each of the day's restarts (f1d956c3
at 04:45Z, 209d1b45 at about 07:52Z). At the peak 436 tournament managers were
quarantined and 487 tables stalled. #5298 fixed the fleet-scan throw and #5317
bounds the retry storm. This change fixes the deadlock underneath them.

Read on production (container log for the sixteen minutes before the 08:55Z
restart, 08:39 to 08:55):

| line                                                                           | count   |
| ------------------------------------------------------------------------------ | ------- |
| `[savePresenceAtPark] <table>: TOURNAMENT_MANAGER_FENCED`                      | 698     |
| `Tournament table <id> retained time-bank custody`                             | 134,904 |
| `tournament_lease_lost_retirement_failed: f06_mixed_bank_evidence_unavailable` | 100,607 |

`/health` showed `stopped_bank_custody_unwritten: 572` and
`stopped_bank_custody_stuck: 27`.

1. A manager loses its lease. Its engines go terminal holding stopped
   time-bank custody.
2. #5255 made the terminal engine write that custody at the break announcement
   with an unconditional upsert, sent under the dead manager's data-actor
   headers. `fn_smarter_data_api_pre_request` fences every request of a lease
   that is no longer current, reads included. The write never lands.
3. The manager's stop fails "retained time-bank custody". Retirement falls to
   the mixed F06 transfer, whose read of `engine_presence_parked` goes out
   under the same dead headers and is fenced too. The manager is quarantined
   and its tables stall.
4. `stopped_bank_custody_stuck` correctly keeps the restart certificate shut,
   so nothing recovers until the engine is restarted by hand.

Only two mixed transfers exist in `f06_manager_custody_transfers`, one of them
never completed. The mixed path had effectively never been able to read its
own evidence.

## The fix

A bank balance frozen at a known hand number is not the manager's data to
exercise authority over. The fence exists to stop a stale manager from
corrupting a successor's live state, and this fix keeps that guarantee in the
database.

- **`public.fn_park_stopped_time_bank_custody`** (SECURITY DEFINER, `service`
  actor only, EXECUTE for `service_role` only). It writes the custody only when
  nothing newer exists, and otherwise refuses by name:
  - `hand_after_custody`: a later hand exists for the table in `hand_history`,
    `hand_atomic_commits` or `hand_state_snapshots`, or an F06 permit other
    than `never_started`.
  - `newer_park`: the existing park row holds a bank snapshot at a higher hand
    number.
  - `mixed_custody_adopted`: the row was written by an F06 mixed completion.
  - `mixed_transfer_recorded`: an open mixed transfer, or one from this same
    generation, names the table. Its CAS evidence includes this row.
  - `custody_transfer_busy`: the function takes the same retired-origin lock as
    the transfer's prepare, so the two never interleave.
  - `table_not_in_tournament`, `concurrent_park`, `existing_park_unreadable`.
    It never uses `ON CONFLICT DO UPDATE`. Measured at 1.1 ms in a rolled-back
    production probe, where every refusal and both write paths were exercised.
- **The engine calls it at the process root** (`parkStoppedTimeBankCustody`,
  bound with `bindToProcessRoot` as #5298 did). The acknowledgement that
  `hasUnretiredStoppedTimeBankCustody()` reads is recorded only when the
  database confirms the write. A refused or unknown answer no longer falls
  through to the ordinary announcement upsert, because that upsert writes
  `time_bank_snapshot: null` over the row. It would erase exactly the newer
  state the database had just protected.
- **The manager's stop writes before it asks.** `TournamentManagerBase.stop()`
  now calls `engine.persistStoppedTimeBankCustody()` for every stopped engine
  before it checks for retained custody. It uses the same serialized
  presence-save chain and the same `shouldPersistStoppedCustody()` gate.
  Before this, a manager that lost its lease at :56 failed its stop on every
  retry until the next break's announcement, up to an hour later. Completed
  tournaments hit the same path (`tournament_completed_cleanup_failed`).
- **The retirement reads its evidence at the process root**
  (`readMixedF06PresenceEvidence`). The request is awaited inside the
  root-bound function, because a PostgREST builder sends its request when it
  is consumed. Returning the builder would send it with the caller's headers.

`unwritten` and `unreadable` still refuse. The gate census and the release
script's allow-list are unchanged. The fix makes the write succeed; it never
admits a bank that is not on disk.

## Why the leases lapse in the first place

- **Heartbeats still share the PostgREST pool with game traffic.**
  `poker_lease_heartbeat_session_enabled{scope="tournament"} 0` on the current
  engine (cd5892e8): `ENGINE_PG_LISTEN_URL` is not set in the container, so all
  263 tournament heartbeat statements went `transport="shared"`.
- **The 07:52 collapse followed a fleet-wide resume burst.** Edge logs show
  requests per minute rising from 9,244 at 07:45 to 19,087 at 07:46 and 26,252
  at 07:51, as dealing restarted across the fleet (`insert_hole_cards` went
  from 0 to about 760 a minute). Tournament heartbeat latency at the edge rose
  from about 260 ms to a p50 of 941 ms and a maximum of 7.6 s at 07:47, and to
  a p50 of 1,465 ms at 07:52. The engine's own event loop adds to that: p50 is
  about 20 ms on a freshly restarted engine, 147 ms while the fleet resumes
  (09:12Z), and 225 ms on the collapsing one.
- **209d1b45 did not carry #5307** ("a heartbeat nobody answered is asked
  again"). The engine now serving (cd5892e8) does.

So a lapse is a load event: a resume burst on a shared pool, with no
dedicated renewal session. What turned each lapse into a collapse was this
deadlock, plus the retry storm #5317 bounds. With this change a lapsed
manager's stop writes its banks at once and retires.

The remaining load-side lever is configuration, not code: setting
`ENGINE_PG_LISTEN_URL` takes lease renewal off the shared pool. It is a
database credential in the engine host's env file, which no agent has a
sanctioned path to write (10.84 and #5307's changelog), so it is left for the
owner.
