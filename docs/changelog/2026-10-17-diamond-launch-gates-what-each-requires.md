# Diamond launch gates: what each remaining gate actually requires (2026-10-17)

Continuation of [the Diamond launch audit](./2026-10-15-diamond-arena-launch-audit.md) and
[the current tournament qualification](./2026-10-17-diamond-current-tournament-qualification.md).
Four gates were open: DA06 funded journey, DA08 failover and Diamond Spin/SNG, DA10 rollback/restore,
and the funded recovery offer under DA22/DA23. This records what each one is, measured, and what
closes it. The launch verdict is unchanged: **not launch certified** while DA06, DA08 failover and DA10 are open.

## Delivery state, 11:00 UTC

- Both client origins serve `038f4c5a` (publisher run 39021647393). It contains #7021 (merge `42a6924b`),
  #7226, #7211 and #7223. The four later commits on main (#7247 to #7250) are test-only, so the
  publisher's runtime admission correctly keeps `038f4c5a`.
- The engine serves `31812752`; its `server/src` is identical to main except one test file.
- No merged change is waiting for publication or engine activation.

## DA08 Diamond Spin/SNG: the format is not offered, so there is no subject

In 72 hours Diamond Arena created 265 tournaments: MTT and SATELLITE only. No SPIN or SNG was
scheduled there. The formats are healthy in the chip clubs over the same window: 36,032 Spins and
24,170 Sit & Gos completed. "Diamond Spins" in `diamond_spin_movements` is the wheel product inside
chip clubs (three players this week), not a Diamond Arena tournament format.

Disposition: not applicable while Diamond Arena schedules neither format. The gate reopens the
moment one is scheduled, and its first natural event must be verified live then.

The 28 cancelled Spins in the window were all in Midway Union between 16:47 and 16:52 UTC on
October 15, horse-only, immediately before the owner's 16:55 floor park (#7050). No real player was
in any of them.

## DA08 failover: there is no standby by design, so failover is crash restart

[Ruling 24](../DIAMOND-RULINGS.md) keeps the engine as one process with no warm standby (Dan,
2026-08-23). A crash is recovered by the container supervisor, so "unplanned failover" can only mean
an unclean death of the single engine followed by its restart. The host confirms that design:
`club-arena-engine` runs with `restart=always`, a `/health`-based healthcheck, and the `sp-autoheal`
watcher restarting it when unhealthy.

A crash rehearsal on production was prepared for the 11:55 UTC break and withdrawn before it ran.
[The drill runbook](../runbooks/maintenance-break-fire-drill.md) retires the direct-SSH container
kill: a workstation may not mutate or restart the engine, and a live crash drill may run only as a
reviewed default-branch repository event with exact SHA, pinned host identity, drill authorization, a
single release lane, table-safe break admission, before/after provenance receipts, automatic refusal
on unclear preconditions, and cache-busted health and hand-progression checks after recovery. That
route does not exist yet. Nothing on the engine host was changed; only read-only inspection ran.

What is already evidenced: 198 planned engine version changes in 30 days, each a full process
replacement inside a break, all with `thaw_ok`; the actual replacement recorded in the Diamond audit preserved 2,436
funded custody records and 44 cash seats with identical frozen fingerprints. The part no replacement
exercises is an unclean death: no SIGTERM drain, leases and leadership left to expire, the supervisor
restarting the same image.

## DA10 rollback/restore: the rollback mode has no caller

`engine-release-seal.py prepare` accepts `--mode rollback`, and its commit keeps the high-water
release when the mode is rollback. Nothing invokes it. `engine-release-transaction.sh`,
`launch-engine-release.sh` and `auto-deploy-hetzner.yml` only ever prepare `deploy`, the workflow
pins `ROLLBACK_REQUESTED: 'false'`, and a normal deploy refuses any target behind the high-water.
The only rollback that can run today is the transaction's automatic restore of the previous engine
after a failed cutover, inside the same break (135-second reserve).

Measured: across every engine version transition in `engine_maintenance_break_log` for 30 days
(198), none moved backwards in history, and `engine_maintenance_break_faults` holds one
cancelled announcement (2026-10-06) and no failed cutover. The automatic restore has never run in
production.

So DA10 cannot be rehearsed by any maintained route, and improvising seal edits on the production
host with funded custody outstanding is not a rehearsal anyone could repeat or trust. Closing DA10
needs an engineering change first: a protected rollback route through the release transaction that
selects a retained image at or above the compatibility floors, keeps the break certificate and the
full reserve, refuses while custody would be stranded, and records the same sealed receipt as a
deploy. It is then rehearsed inside a scheduled break as rollback, then roll-forward.

The client side already has its mechanism (repointing `current` at a retained release, ten-release
budget), but the publisher refuses a requested SHA that is not current main, so it has the same
missing caller.

## DA06 funded journey: the ledger half holds at scale; the human UI half is still owed

Read-only, every Diamond cash seat released in the last seven days: 2,550 seats, 237 players.
Zero residual custody, zero seats missing their wallet buy-in leg, zero positive releases without a
wallet journal, zero dangling journal references, zero open custody without a seat. The 19,492
releases without a wallet journal are all zero-amount (busted seats). Horses use the same money
doors (CLAUDE.md 10.5), so this is the ledger and custody behaviour of the production journey.

What it does not prove is the human path through the published client: the cashier buy-in, the
leave control, and the wallet transfer screen, and the funded recovery offer (DA22/DA23). Only three
Diamond wallet transfers have ever been made on the platform. Agents may not stake real Diamonds
(1 Diamond = 1 cent), so a real player completes that journey and
`scripts/ops/diamond-funded-journey-certificate.sql` certifies it read-only. It checks the
buy-in leg, at least one settled hand, the leave release, zero residual custody, every wallet journal
and both legs of the transfer. Dry-run on a real natural journey: the four cash checks pass and the
transfer check correctly fails when no transfer exists.

## Remaining, exactly

| Gate                                   | Status                                                           | Closes when                                                                                                                                            |
| -------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| DA06 funded journey and recovery offer | Ledger proven at scale; human UI journey not yet run             | A real player completes buy-in, one hand, leave, transfer (and a Diamond tournament rebuy or add-on for the recovery offer) and the certificate passes |
| DA08 failover                          | Not rehearsable today: the controlled drill route does not exist | The drill route below is built, then one crash drill runs inside a scheduled break                                                                     |
| DA08 Spin/SNG                          | Not applicable: not offered in Diamond Arena                     | Reopens with the first scheduled Diamond Spin or SNG                                                                                                   |
| DA10 rollback/restore                  | Unrehearsable: rollback mode has no caller                       | A protected rollback route is built, then rehearsed inside a scheduled break                                                                           |

## The one engineering change that unblocks DA08 and DA10

Both gates need the same thing: a controlled engine drill route, built to the runbook's list, as a
reviewed default-branch repository event that drives the existing release transaction and seal. It
carries two drills. A crash drill admits a scheduled break, records provenance, kills the serving
container uncleanly, and proves supervisor restart, lease and leadership recovery, thaw and hand
progression. A rollback drill selects a retained image at or above the compatibility floors,
prepares it through the seal's existing `rollback` mode with the full break certificate and reserve,
refuses while custody would be stranded, proves the restored release serves the outstanding funded
custody, then rolls forward to the high-water release in a later break. Until it exists, neither gate
can be closed honestly, and nobody should improvise either drill from a workstation.
