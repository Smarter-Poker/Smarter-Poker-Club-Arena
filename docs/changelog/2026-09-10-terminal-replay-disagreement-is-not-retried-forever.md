# A terminal replay that disagrees with the stored receipt is not retried forever (2026-09-10)

## What happened

Postgres logs, 2026-09-10 (UTC). `fn_complete_tournament_terminal` raised
ERROR 40001 `terminal replay parameters disagree with stored receipt for
<tournament>`:

| tournament | event                      | receipt committed | refusals | burst               | rate    |
| ---------- | -------------------------- | ----------------- | -------- | ------------------- | ------- |
| 744bac40   | 2 Chip Deep Stack Spin NLH | 05:40:16          | 1,621    | 05:40:30 - 05:40:58 | ~58 / s |
| b6e2333f   | NLH Heads-Up 100           | 06:13:37          | 2,236    | 06:13:48 - 06:14:17 | ~80 / s |
| 7264e9bf   | 1 Chip Deep Stack Spin NLH | 06:22:26          | 1,718    | 06:22:38 - 06:23:12 | ~52 / s |

5,575 refusals. Every burst started 11-14 s after the receipt row existed and
the tournament was already `COMPLETED` (the receipt insert and the status flip
are one transaction). Every burst ended the moment the manager was fenced: the
first `TOURNAMENT_MANAGER_FENCED` for b6e2333f is stamped 06:14:16.740, the
last disagreement 06:14:16.780. The calls came through PostgREST on two
sessions, 1-2 ms apart, with `parsed.query` the direct
`fn_complete_tournament_terminal` RPC (not the resolver), so this was the
engine's own replay of a request the database had already answered.

In the same window, `TOURNAMENT_MANAGER_FENCED: lease generation is no longer
current` (42501, raised by `fn_smarter_data_api_pre_request`) held a flat
243 a minute from 05:15 until the 05:55 restart: 3,986 in the hour, about
twenty managers each re-asking every 5 s (`UNRESOLVED_BUST_RETRY_MS`). That is
a retry loop, not a restart artefact. `engine_recovery_events` shows the
engine losing every tournament lease in waves every two to four minutes across
the whole window (`tournament_lease_lost`, 18-73 tables at a time) with two
builds heartbeating at once (`deploy_truth.engine_split_brain` 05:57,
`ClubArenaEngineKillStorm` 06:00). The lease storm is not fixed here; it is
what kept handing these tournaments to a manager that had not committed the
receipt itself.

## Why the parameters differ

The database compares exactly two things against
`tournament_terminal_settlements` on a replay: `settlement_mode` and, when one
is supplied, `winner_id` (`fn_complete_tournament_terminal`, the receipt-first
block). Nothing else - no standings, no payouts, no ledger snapshot - is part
of the disagreement. The stored receipts for all three events are
`places` with the champion who holds `tournament_players.position = 1` and
`status = 'winner'`, and that champion is the only row that could ever pass.

The engine's later request carried a different winner. Once the terminal
authority has settled the event the champion is no longer `status = 'playing'`
but `status = 'winner'`. A manager that reads the field only now (re-admitted
after a lease loss, or the other engine of a split brain) counts zero live
players, finds no `playing` row, and takes the "all busted simultaneously -
last eliminated wins" branch of the elimination sweep: the most recently
eliminated player, which in a heads-up or a three-handed spin is the
runner-up. That is the observed winner it then submitted.

## Why it looped

`requestTournamentTerminalReceipt` treated the 40001 like a lost response and
replayed the identical request (five attempts), then asked
`fn_resolve_tournament_terminal_outcome` with the same parameters, which
raises the same disagreement, and finally reported "outcome unknown". Nothing
in that chain read the receipt the database was refusing to hand over. The
"unknown" verdict fenced the manager, the lease storm admitted the next one,
and the next one asked the same wrong question.

For the fence: no code in the engine read the string `TOURNAMENT_MANAGER_FENCED`
at all. A manager whose in-process lease proof was still being renewed saw the
403 as one more failed statement and re-armed its five-second retry, for forty
minutes, until the process restarted.

## The mechanism

`server/src/tournament/terminalSettlementRpc.ts`

- `isTerminalReplayDisagreement` recognises exactly the two database texts
  (`terminal replay|outcome parameters disagree with stored receipt`).
- The attempt loop no longer replays a disagreement. It reads
  `tournament_terminal_settlements` (settlement_mode, winner_id) and replays
  ONCE with the receipt's own parameters, so the same authority returns the
  same immutable receipt (`adoptStoredTerminalReceipt`). The receipt is the
  witness that was there (CLAUDE.md 10.9); this process's observation is not.
- The read-and-adopt is bounded (`receiptReadAttempts`, default 3, cap 5). If
  the receipt row is not visible, is malformed, agrees with the observation
  after all, or the stored parameters are refused too, it throws
  `TerminalSettlementDisagreementError` carrying the tournament, the observed
  and the stored parameters. It is never an unknown outcome and never a
  refusal that re-arms.
- The serialized resolver's own disagreement is handled the same way.

`server/src/tournament/TournamentManagerEliminations.ts`

- `finishTournament`: a `TerminalSettlementDisagreementError` raises ONE
  critical `financial_alerts` row (`Tournament.atomic_finish_receipt_disagreement`)
  naming the tournament and both parameter sets, then the manager stands down
  (`fenceUnknownTerminalOutcome`). It is not re-armed.
- An adopted receipt whose winner differs from the candidate is announced
  once (`Tournament.atomic_finish_receipt_adopted`, warning) and cleanup
  proceeds from the receipt, as it always did.
- The zero-live-players branch of the sweep asks for the durable winner
  (`status = 'winner'`, `position = 1`) before it elects the last eliminated
  player. An unreadable row is unknown: retry later, never fall through.

`server/src/tournament/tournamentRecovery.ts`

- The same error class gets its own single alert
  (`Tournament.recovery_terminal_receipt_disagreement`) instead of the
  "unknown outcome" path.

`server/src/services/supabase/tournamentManagerFence.ts` (new),
`client.ts`, `TournamentManagerBase.ts`

- Every manager generation registers a stand-down handler keyed by
  (tournament, lease generation) when it is constructed.
- The one shared fetch boundary inspects a 403 made inside a manager context;
  a body carrying `TOURNAMENT_MANAGER_FENCED` is delivered to that exact
  generation, once. The response is still returned so the caller's own error
  handling runs.
- `standDownForDatabaseFence` fences every async continuation synchronously
  (`fenceForTournamentLeaseLoss`), reports `Tournament.manager_fenced_by_database`
  once, and tears the manager down. GameServer retires it on its next lease
  pass because it no longer reports current authority. The registration is
  released by the stop fence, so a burst of refused requests cannot stand it
  down twice.

No migration. No money moved: the three receipts were already correct and the
tournaments already `COMPLETED`; nothing here rewrites a settled record.

## How it was verified

- `server/src/tournament/terminalSettlementRpc.test.ts` (11): disagree ->
  adopt the stored receipt and complete with one refused call and one replay
  carrying the receipt's parameters, never the resolver; a final-table-deal
  receipt is adopted over a places request; disagree with no visible receipt
  -> the refused request is sent once, the receipt read three times, then
  `TerminalSettlementDisagreementError` with the observed/stored detail;
  stored parameters refused too -> bounded; the resolver's disagreement is
  adopted.
- `server/src/tournament/AFencedManagerStandsDown.test.ts` (4): the fence is
  recognised in any error shape; delivered only to the exact generation and
  only once; read off a 403 only inside the manager context that sent it, with
  the body left readable for the caller; a live manager with a valid proof
  deadline loses authority synchronously, stops running, releases its
  registration, reports once, and a second fence is a no-op.
- `server/src/tournament/TerminalReplayDisagreementIsNotRetriedForever.guard.test.ts`
  (8): call-site guards for the finish, the sweep ordering, and recovery.
- `RecoveryReceiptLogging.guard.test.ts` updated in the same commit: the RPC
  helper now verifies a receipt in three places, not two.
- `cd server && npx tsc --noEmit` clean; `npx vitest run src/tournament
src/services/supabase` 1,826 passed; root `npx vitest run` over the nine
  law/guard suites that read these files, 207 passed.
