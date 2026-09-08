# Cancelled Spins reverse their aggregate rake attribution

atomic_cancel_tournament reversed fee rows by metadata.user_id. fn_spin_book_entry writes an aggregate row with no such field. A cancelled event could refund all entrants while retaining its rake attribution.

The original cancellation now reverses each positive aggregate Spin entry row's remaining amount in the same transaction, preserving its contribution map and recording original_rake_record_id. Prior reversals are subtracted. The fee cash is already returned by the player refund; the existing escrow trigger excludes negative atomic_cancel_tournament attribution rows.

Actual-function probes reproduced the omission and passed 0.48 fee netting to zero, six chips refunded once, terminal replay refusal, partial earlier reversal, preserved attribution identity and rollback of refunds/status when reversal insertion fails. The refund RPC was stubbed; live wallet, reserve, reporting and escrow triggers and concurrent sessions were not exercised.

Applied migration: 20260907223105. Historical example 98e4b933-60d8-4506-9861-3d755d243a72 remains unchanged: the original row and downstream distribution/history need a separate evidence-based forward reconciliation. No new sweep or repair job was introduced. Full Spin reserve-contribution reversal and original lifecycle integration remain open.
