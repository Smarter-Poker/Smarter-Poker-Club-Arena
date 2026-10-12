# Two tournament stalls that had no way out (2026-10-01)

Post-Deploy E2E `Live-table and engine verification` failed in both recent
runs (latest 36861073599). It found table `a2d8a54e` ($100 Freeroll 6:00 AM,
nine seated) dealing nothing from 11:46:17Z, and MTT table `0db3bb98` silent
for 45,046 ms after a hand finished. At 13:09Z `/health` listed 16 stalled and
16 dead-stalled tables. All 16 had only horses seated, and 10.5 treats a horse
stall the same as a human one. No open PR or branch owned either cause. The
process had not restarted since 00:56Z, so none of the :55 breaks that day
replaced it.

## Stall 1: a2d8a54e, a stopped original whose permit the park took

Timeline, read from engine logs and `smarter_private.f06_*` rows:

- 11:46:16 hand 19485600 settles (`f06_hand_permits` row `accepted`).
- 11:46:29 `fn_f06_begin_hand` for the next hand is lost
  (`f06_permit_unproven`). The permit stays `unknown`, and every later deal
  refuses `f06_prior_hand_unresolved` or `f06_allocation_unproven`.
- 11:49:22 the zombie watchdog kills the engine (`tournament_table_zombie`).
- 11:49:52 the stopped-original recovery parks the table as break `c0b625dd`
  (`park_requested`). At 11:49:53 the first custody claim misses
  ("F06 custody claim identity mismatch before stop"), and the retries that
  follow hit `fn_f06_table_state` statement timeouts.
- 11:53:01 the maintenance announcement's stopped-custody park releases that
  never-started permit (`f06_absent_permit_releases`, hand 19485877) and
  `persistStoppedCustodyForRestart` drops the permit object.
- From 12:05:24 every retirement of `c0b625dd` refused
  `f06_stopped_original_permit_mismatch`, 426 times by 13:15. The break is
  bound to the stopped original, and `admitF06StoppedOriginalMovement`
  demanded `this.f06CurrentPermit`, which the park had already released.

**Cause:** `server/src/engine/ServerTableEngineBase.ts`,
`admitF06StoppedOriginalMovement`. It required a live permit, but the park's
release is the same never-started fact that `finishF06OriginalNoStart` would
have written.

**Fix:** when the park names the permit back, the engine keeps that permit's
binding (`f06ParkReleasedPermit`). Movement admission accepts it in place of a
live permit, but only after reading the exact park claim (state, break,
custody, revision, generation, tournament, table, lifecycle). It writes no
second no-start record. The binding is cleared the moment a new permit is
reserved, and it never grants hand authority. `fn_f06_begin_break` only
refuses a `reserved` permit row, so the break proceeds from there.

## Stall 2: fifteen tables at 12:27Z whose teardown "failed"

At about 12:26:56Z the engine got a 10 s `ConnectTimeoutError` to the
database. On 15 tournament tables (two MTT, thirteen SNG and Spin), the
post-commit stack read failed after the hand had already committed
(`post_commit_stack_refresh_failed`), and so did the terminal snapshot flush.
Each stop rejected "teardown failed in 2 operation(s)" after capturing the
banks and releasing process ownership. `GameServer.replaceTableEngine`
accepts that case on purpose ("retaining the terminal object would turn a
diagnostic into a permanent outage"), then calls
`adoptStoppedTimeBankCustody`. That method required
`terminalTeardownComplete`, which a stop that had any failure never sets, so
every replacement was refused and the recovery loop rethrew the same 12:27
error for the next 45+ minutes. `0db3bb98` only came back because the
balancer broke the table at 12:30.

**Cause:** `ServerTableEngineBase.adoptStoppedTimeBankCustody` gated custody
transfer on "no failures" rather than "drained". Added in #4914 (2026-09-20).

**Fix:** a new `terminalTeardownDrained` flag is set when `performStop`
reaches its end, meaning every captured writer has been joined and resources
released. Adoption requires that flag instead. The other guards are
unchanged: banks captured, ownership released, no unknown debit or pending
presence save, no unresolved F06 preparation, no claimed move boundary, same
lease. A hand whose outcome is unknown stays fenced by its F06 permit row.

## Pinned

- `server/src/tournament/aStoppedOriginalWhoseParkReleasedItsPermitStillRetires.law.test.ts`
  (registered in `docs/laws.d/`). On the old code it fails with the
  production error `f06_stopped_original_permit_mismatch`.
- `server/src/engine/ParkedTimeBank.test.ts`. A teardown whose snapshot flush
  rejected still hands its banks to the replacement through
  `replaceTableEngine`, and no bank is handed on while a stop is still
  draining. On the old code it fails with the production AggregateError.

No watchdog, sweep or repair job was added. Both fixes change the live path
that refused.
