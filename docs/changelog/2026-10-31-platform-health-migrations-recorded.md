# 2026-10-31 - Platform health migrations recorded byte-exact

Seventeen migrations were installed in production on 2026-10-31 through the Supabase MCP
while the platform-health programme was fixing live false "Tables Have Stopped Dealing"
pages. This pull request records each one byte for byte from
`supabase_migrations.schema_migrations.statements` (via `public.fn_ca_migration_text`) and
adds its row to `scripts/ci/recorded-migrations.manifest.json`. Nothing is replayed.

| Version                          | What it installed                                                                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 20261031172116                   | Operational alerts route to Production Alerts, never to the phone                                                                           |
| 20261031172724 / 172826          | Closed Diamond Arena liveness findings are the owner's decision, filed resolved at info; money findings keep their severity                 |
| 20261031182341                   | The 60-second table stall watch (detector only)                                                                                             |
| 20261031182400                   | Owner holds are not counted as overdue starts or stopped play                                                                               |
| 20261031182445                   | pg_cron job `ca-table-stall-watch-10s`                                                                                                      |
| 20261031183410                   | Lightning latency alerts resolve with hysteresis                                                                                            |
| 20261031184258                   | Informational Diamond journal and adjustment-approval notices arrive closed                                                                 |
| 20261031190452 / 190637 / 202225 | Stall watch knows legitimate waits, stale or restarted telemetry and unsettled stop custody; maintenance is honoured for at most 12 minutes |
| 20261031191120                   | Mirror alert receipts and resolved twins are informational; critical financial and drift firing rows stay open                              |
| 20261031191337                   | Signup audit asserts the five auth.users triggers by name                                                                                   |
| 20261031192524                   | Daily digest emits the twelve Phase 4 health and security keys                                                                              |
| 20261031202221 / 202222          | Engine restart-gate outcomes and deploy exit paths (needed by the engine pull request)                                                      |
| 20261031203954                   | One-time close of 167 proven street-integrity false positives (engine eed06fe5 counted the pot twice; fixed in #8634)                       |

Three file-text guards raise findings on these recordings. Each was read against production
on 2026-10-31 and the verdict is in the manifest row: the two `check-definer-authorization`
findings and the `check-unqualified-writes` finding are false of production today; the
`check-no-new-band-aids` finding (the 10-second cron) is true and is a read-only detector,
not a repair.
