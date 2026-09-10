# B11 Equal-Prize Satellite Stop Boundary

Observed 2026-09-10. Scope: the offered multi-seat satellite format only. This completes a bounded reproduction of the remaining B11 stopping gap; it does not close B11.

## Requirement and repository authority

B11: “Publish and enforce deals, shootouts, phased events and equal-prize stopping rules only where those formats are offered.”

The actual UI/API offers satellites with target and seat-count settings. `AGENT_SKILLS/POKER_TOURNAMENTS.md` describes the top N players receiving target seats and residual funds going to bubble finishers. Its statement about ticket value predates the current fee-inclusive settlement, so the live money authority below controls the amount.

`server/src/services/TournamentBrainContext.ts`, lines 71–89, preserves Dan’s 2026-09-02 distinction between satellites where every winner receives the same prize and progressively paying MTTs. The implementation describes the Kth ticket as worth the first. The original quote also appears in `docs/changelog/2026-09-02-horse-brain-audit-phase-4-tournaments.md`.

Those sources establish equal prizes. They do not publish a complete multi-survivor stopping contract, final placement representation, or a tie policy for an elimination batch that crosses the ticket threshold. The strategy module's `max(configuredSeats, affordable)` is not the settlement authority and must not become a stopping rule by assumption.

## Actual manager reproduction

Source head: `8912655b21eb3e779bfe23b0249c96d4869933de`, branch `agent/codex-poker-audit-sep09/fix/tournament-pause-release`. Relevant tracked source had no diff at evidence capture, 2026-09-10T05:09:41.247176Z.

The temporary test invokes the actual `TournamentManagerEliminations.prototype.runEliminationSweep` with a valid continuation at finish stage 2. It uses an isolated Supabase response, disables network access, and yields on the work budget after the finish phase. It does not copy the condition into a test helper.

| Fixture                                                                      | Actual observed behavior                                                                                                |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Satellite cache, two advertised seats, finalized pool, two playing survivors | Reads the count, takes the `remainingCount > 1` branch, advances cursor to stage 3, and never calls `finishTournament`. |
| Same fixture, one playing survivor                                           | Reads that survivor and calls `finishTournament(winnerId)` exactly once.                                                |

Both cases passed: 2 tests, 1 file, exit 0, 1.28 seconds. Passing means the current single-survivor behavior was reproduced; it does not mean the equal-prize requirement passed.

The count fixture proves caller behavior, not database funding or settlement. A concrete minimal acceptance scenario is two funded equal tickets, exactly two settled survivors, finalized entry pool, and zero remainder. That scenario does not require choosing a new cash allocation policy.

Files retained on the Mac:

- `/tmp/codex-b11-satellite-stop.test.ts`
- `/tmp/codex-b11-satellite-stop.config.ts`
- `/tmp/codex-b11-satellite-stop.log`
- `/tmp/codex-b11-satellite-stop-evidence.json`

Run from the full tree's `server/` directory:

```sh
PATH=/opt/homebrew/bin:$PATH node ../node_modules/vitest/vitest.mjs run --config /tmp/codex-b11-satellite-stop.config.ts
```

Test SHA-256: `39c85a4e5e5d72a2aa7933532dd651d17c515b39b2609d4f4b910f602c983729`.
Manager source SHA-256: `edcf5a8f4a54e5938c68a9e584d4bf7a8f8c9f45550a17d35ebff09fa174c666`.

## Current finalizer contract

Read-only catalog observation: 2026-09-10 05:03:03.522098+00, project `kuklfnapbkmacvwxktbh`.

- `fn_settle_satellite_tournament(uuid,uuid)`: MD5 `486d0e6729de8d518d7faf0c253b65d3`.
- Current called core `fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)`: MD5 `1f2840c863f42e0fcee4e73aeb28cb88`.

The manager enters `finishTournament` only at at most one survivor. Satellite classification then routes through `processSatelliteAwards` and `requestSatelliteSettlementReceipt` to the atomic satellite RPC.

The current core:

1. Requires a finalized pool and locks the target contract.
2. Uses target buy-in plus entry fee as ticket cost.
3. Rejects more than one playing/winner row with SQLSTATE 55000.
4. Requires a matching observed winner from the sole survivor or a uniquely ordered final elimination witness, assigns that player first place, and requires all other entrants to have distinct durable elimination sequences.
5. Rebuilds contiguous final standings, then derives ticket count as `floor(pool / ticketCost)`.
6. Assigns any residual to the single finisher at ticket count plus one.

The catalog body was inspected, not executed against production or a synthetic schema. A one-line manager threshold change would still be refused by this finalizer and would not implement equal-prize stopping.

## Remaining acceptance inputs and bounded next change

The next implementation needs a satellite-specific terminal contract that accepts the funded survivor set at a settled boundary and produces the existing atomic ticket/obligation/closure receipts without pretending those survivors were eliminated.

Before choosing final placement or remainder recipients, the authoritative contract must specify:

- Whether equal surviving ticket winners share a finish position or receive administrative unique positions, and what `winner_id` means in that receipt.
- How an accepted hand or simultaneous-table batch that moves the field from above K to below K determines the remaining ticket recipients and the K+1 residual recipient.
- The exact accepted boundary proving entry is finalized and all participating hands/eliminations are settled before the survivor set is fixed.

The no-remainder, exactly-K scenario above is the smallest meaningful acceptance case. Threshold-crossing and nonzero-remainder cases additionally depend on the shared elimination-order policy tracked in T08/BX12; this lane must not invent it. Existing cash substitution and unregister policies need no change for this stopping correction.

No production mutation, tracked code change, dependency installation, or repeated UI test was performed in this subtask.
