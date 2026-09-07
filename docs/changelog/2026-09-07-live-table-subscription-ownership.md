# Live Table Connection Audit: Subscription Ownership

## Status

Four transport defects reproduced and patched. This is a verified repair of
client and server subscription ownership, not certification of the entire live
game system. Production deployment, full repository checks, browser soak, and
the separate intermittent handshake-timeout investigation remain outstanding.

Reviewed source began at `89a29af8ec19b140b6129dfb553d4e79b99416c2`.
The patch incorporates the warm-subscription adoption changes on
`0ea76a50ca02d55e08aa0cec30857d4a0c95ca92`, rather than overwriting them.

## Reproduced Defects And Fixes

1. **An old client could unsubscribe its replacement.** `MuxTableSocket.close`
   passed only a table ID to `release`. After another client acquired that table,
   delayed cleanup of the old client removed the new facade and sent UNSUBSCRIBE
   for it. `sendFor` had the same ownership gap. Both now receive the actual
   facade and require identity equality with the current owner. The existing
   ownership test accidentally checked T2 after releasing a superseded T1;
   it now checks T1 too. Regression coverage proves the replacement continues
   receiving snapshots and can later release itself normally.

2. **Browser sleep could strand the next table connection.** `acquire` registered
   the new facade before retiring a stale physical socket. Retirement called
   `failAll`, closing the new facade before its caller attached onclose. The
   client handshake timer only acted on CONNECTING, leaving that CLOSED facade
   without recovery. Registration now follows stale transport retirement.
   A prior subscription on a stale socket is not eligible for warm adoption.
   Tests advance wall time without running watchdogs to model browser sleep,
   both with and without a previously subscribed table.

3. **Socket construction errors could disappear before recovery was attached.**
   `ensureSocket` synchronously failed waiting facades inside `acquire`.
   It now detaches the failed generation immediately and delivers its close
   notifications in a microtask, after callers attach their handlers. The
   captured generation cannot close a subsequent successful acquire.

4. **Cancelled server gate checks could mutate the next attempt.** Server
   subscriptions used the same literal `pending` for every attempt. An
   UNSUBSCRIBE followed by SUBSCRIBE while access checks were pending allowed
   the old result to authorize, delete, or reject the new subscription. Each
   pending attempt now has a unique symbol. Ownership is checked after access
   checks, after asynchronous table startup, and before failure cleanup.
   Tests cover stale successful and denied access checks, plus a cancelled
   startup that returns missing or throws after its replacement has subscribed.

Production callers remain `EngineStateClient.openOnceInner` and lobby
`tableWarmup.warmSocket` for client acquisition, and
`EngineWebSocketServer.handleMuxMessage` for server subscribe/unsubscribe.
No poker rules, balances, access policy verdicts, animation timing, maintenance
schedule, or deployment credentials were changed.

## Live Evidence, 2026-09-07 UTC

Read-only Supabase queries used project `kuklfnapbkmacvwxktbh`, confirmed by
the repository configuration. No production SQL writes were performed.

- At approximately 20:04, the latest 12 `table-socket-probe` rows were OK and
  received SNAPSHOT. Socket opening times were approximately 1.21 to 4.93 seconds.
- The 24-hour query around 20:10 returned 272 probes: 236 OK, 36 failed.
  Of the failures, 29 were `handshake_timeout` with close code 1006, one was
  `refused` with code 1006, and six had no socket outcome in that field.
- Successful probes had median total duration 3,681.5 ms and p95 7,905.75 ms.
  Failed probes had median total duration 15,433 ms.
- The failures at 18:33, 18:43, and 18:48 logged successful login in 220 to
  282 ms and table lookup in 57 to 63 ms, followed by no socket opening within
  15,000 ms. These failures are not proven to be caused by the mux defects:
  the synthetic probe uses the single-table endpoint, whereas the normal
  frontend uses the multiplexed endpoint by default.
- The public engine health endpoint returned version `0fe61037`, no stalled
  tables, and active dealing. An early sample reported equity governor scale
  0.35, p50 event-loop delay 96.34 ms and p99 294.13 ms. A later cache-busted
  sample reported scale 1, p50 20.35 ms and p99 71.11 ms. This establishes
  varying load, not a proven cause of the 15-second timeouts.
- Database activity showed transient transaction waits in one sample. A
  follow-up had zero blocked backends and oldest idle transaction 0.062 seconds.
  Both Realtime replication slots were active, with reported retained WAL
  approximately 12 MB and 30 kB. These spot checks do not rule out intermittent
  database or Realtime incidents.
- The frontend build-info response read during the investigation reported
  `f53c1a4763bb035f62e2a29c55a2db0d29ccec4d`, built at 20:03:25 UTC.
  That is a baseline observation, not evidence that this patch is live.

## Verification

- Before the client fix: 4 assertions failed, including the corrected existing
  test and three new reproductions. After the fixes and upstream reconciliation:
  **18 client mux tests passed** using Vitest 4.0.18 and happy-dom 20.11.6.
- Before the server fix: both access-check cancellation reproductions failed.
  After the fix, startup cancellation cases, and wider transport verification:
  **67 server tests passed** across mux, URL/auth parsing, IP restriction, and
  mux metrics suites. Server tests used the repository configuration and exact
  `server/package-lock.json` dependencies, including Vitest 2.1.9.
- Strict targeted TypeScript checks passed for each changed transport module,
  including the server's imported dependency graph with TypeScript 5.9.3.
- The server's existing no-credential test fallback emitted a service-role
  warning in the two non-mocked suites; those tests passed and no production
  credential was injected.
- Full `npm run build`, repository-wide typechecking/tests, and real-browser
  network interruption tests were not completed in this partial cloud checkout.
  Required CI gates must remain intact; focused tests do not replace them.
- No `--no-verify`, force push, main-branch write, manual merge, server restart,
  or credential replacement was used for this work.

## Remaining Investigation

1. Correlate the recorded 15-second handshake failures with Caddy access/error
   logs, engine upgrade/auth timings, event-loop and CPU metrics, and server
   deployment/restart history. Do not attribute them to the patched mux races
   without evidence from the single-table path.
2. Verify the required checks and serving frontend SHA / engine version for
   this change. A green workflow alone does not prove engine cutover.
3. Run an authenticated, dedicated test identity through lobby warm-up, table
   entry, four-table play, rapid close/reopen, network loss/restoration, browser
   sleep/wake, auth refresh, and a scheduled maintenance cycle. Do not use a
   person's account for synthetic login/logout or spend production chips.
4. Measure continuous SNAPSHOT/DELTA/EVENT delivery and rendered actions,
   dealing, showdown, pot pushes, audio, and animation completion under those
   scenarios. Initial-snapshot probes do not establish persistent connection
   or animation health. No animation behavior was changed in this patch.

## Access Boundary

GitHub connector read/write capabilities, Supabase SQL reads, npm downloads,
and public engine HTTPS were available. Direct private-repository git clone
failed for missing authentication. The user's Mac paths were not mounted.
No `.env` credentials were present under the accessible workspace/mount/temp
locations or the documented local Documents path; no matching credential
environment variables or SSH keys were available. No host-terminal or device
bridge tool was exposed. SSH to the runbook's `5.161.252.33` returned
`Network is unreachable` before authentication. Existing repo secrets cannot
be read back through GitHub. This is not a permission request, and no new
credential or alternate remote-access mechanism was created to work around it.
