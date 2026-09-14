# Must-Move readiness follows the original seat occupancy

A swap side that had reached its hand boundary was held only in the old
engine's memory. After a restart, or an executor response lost after the
database stored `ready_at`, the next deal could include that player while
the partner table was allowed to move the chair. Pending-move reads now
include the original occupancy; the engine restores that exact stay's hold
before dealing, defers when the read is unknown, and rechecks the selected
roster under the seat boundary. Late reads cannot update a retired engine.

Queued entry-hold writes also bind the occupancy captured when the decision
was made. A player leaving and returning to the same table cannot inherit an
old stay's delayed entry-state update. Move receipts must match the planner's
original occupancy before local cleanup is allowed.

## Verification

- Three initial regressions failed against the starting source: delayed
  entry writes reached a replacement stay, restart lost the ready swap hold,
  and a pending read resolving after retirement changed local hold state.
- Six behavior tests cover these boundaries, unknown reads, replacement
  stays and a deal roster selected before the hold was restored.
- Full server suite: 808 files passed, 12,005 tests passed; 146 opt-in native
  database tests skipped in that command and passed in a separate PostgreSQL
  17.11 run. Server TypeScript check passed.
- Native departure tests apply the migration and verify original occupancy,
  durable swap readiness, expiry and service-role-only execution, alongside
  cashout, transfer, concurrent ownership and lost-response recovery.
- Two existing dealing fixtures now return the new successful-read boolean;
  their 19 pause/launch tests pass without changing tournament behavior.
- Focused client baseline: 14 files, 219 tests passed. Full client typecheck
  requires CI because the shared Mac dependency set lacks declared native
  packages. No packages were installed or copied on the Mac.

## Release and remaining acceptance

Apply `20260914101745_cash_pending_moves_carry_original_occupancy.sql`
before the engine release. It changes one existing service RPC, preserves
its grants and filters, and refuses an unreviewed function-body baseline.
The previous engine tolerates the additional response field. The new engine
fails closed when original occupancy is absent.

This change does not certify Phase 2 readiness. On 2026-09-14 three funded
Must-Move tables had not advanced after hands accepted around 09:12 UTC;
their post-commit envelopes completed but their local settlement barriers
remained blocked for over 75 minutes. This is separate from the entry/swap
defects reproduced here. Its root cause and sustained post-release recovery
remain acceptance requirements. Lightning Games have not been implemented.
