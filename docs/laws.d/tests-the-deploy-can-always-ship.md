# tests/the-deploy-can-always-ship.law.test.ts

A green deploy run must either ship the commit or say truthfully why it did
not. Pins the three ways it stopped doing that on 2026-09-05, when 52 of 98
attempts in 72 hours shipped nothing and every one reported success: the job
timeout and the break gate's wait budget must be the same number and must
leave every scheduled tick able to reach the next :55 (a budget that shrank
under a growing build is what made an off-cycle dispatch arithmetically
incapable of landing); the restart-spacing gate must measure the last deploy
WE shipped, from `ca_engine_deploy_attempts`, never `/health.uptime`, which
anything restarting the container resets — and must report an engine younger
than our own last deploy as an unplanned, unannounced restart; every path
that declines the cutover must record its own `gate_reason`, which the run
warning, the job summary and the deploy ledger all read, so one run can never
again give three different answers; the deleted 7am/7pm restart-window gate
(`steps.window`) must not be referenced as though it were live (§13); and an
image already staged for a commit must be adopted rather than rebuilt, which
is what leaves a retry enough budget to wait for the break.
