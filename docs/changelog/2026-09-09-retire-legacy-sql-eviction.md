# Retire SQL eviction outside the live-hand owner

The minute cron sp_evict_sitting_out_cash_players calls player_leave_table directly using table/user identity. It cannot consult the engine's live hand and can act on a pre-settlement stack or a replacement seat. The engine already owns timed sit-out, abandoned-seat, busted-seat and tournament-elimination lifecycles. The SQL job is a competing financial writer, not the authoritative lifecycle.

Migration 20260909045227 unschedules only the verified single-statement eviction jobs, revokes all application-role execution, and makes direct owner invocation reject explicitly. It retains the retired function signature for schema compatibility. No wallet, journal, seat or incident data is adjusted, and no watcher is introduced. Unexpected function definitions, other SQL callers, or mixed job commands abort before retirement.

Read-only preflight found one active job, id 152, every minute, and no other public SQL callers. The installed function fingerprint is edade8a266655ff341bc97bbb4cf8f0b; retired fingerprint is 6545e433f41651de49e89a1dd9ca39a1. Public engine health was ok at version 5a620865 (uptime 419 seconds at observation). Its relevant lifecycle files match the tested f29409c57 release baseline. No engine restart is needed for this independent retirement.

Validation: the standalone disposable PostgreSQL script passes exact baseline verification, repeated complete migration application, unrelated-job preservation, owner/app-role refusal, and transaction rollback for unexpected commands/callers. Its cron.unschedule(bigint) adapter models the installed API for job selection/transaction tests; it does not run the pg_cron scheduler. Existing cash eviction/presence/restart tests passed all 41 cases; tournament elimination authority/ownership tests passed all 20 cases.

Release follows .github/DEPLOYMENT.md: normal private feature branch, required CI, Autopilot and Hetzner. Production application, catalog verification and published build evidence are separate pending gates. This release is not Phase 2 completion and does not retire the remaining SQL cluster/closing cashout paths.
