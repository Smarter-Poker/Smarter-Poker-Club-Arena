# Private cash earning-seat source correction

**Source review only; all new regressions UNRUN pending protected execution.** Component `20260914160000_private_cash_attribution_preserves_recorded_seat_scope.sql` is forward-only and changes `fn_cash_earning_club` with its existing ACL. Component A and its historical hashes remain untouched. Apply the new component after A and the durable source worker Q; appending it after the current accounting components satisfies that dependency.

The old private branch returned the host club before consulting the hand's seat. A valid cross-club funded seat could therefore become a host-club attribution and evade the later mismatch check. Future private sources now use the recorded club at `hand_history.started_at`, including a prior seat whose player later left or re-seated. Current memberships and a preferred/home club are never fallback evidence. No rate, bank destination, source repair, historical liability or seat admission policy changes.

## Why unknown evidence stays NULL

`atomic_distribute_rake` calls this helper inside its attribution INSERT, before bank credits and the exact bank receipt. The accepted-hand post-commit processor invokes that same bank RPC before finishing the durable obligations. The engine also has a legacy record lane and a later FeeReconciler replay. A strict new private-seat exception here could strand an already accepted hand's rake banking if historical seat data were missing, overwritten or ambiguous.

For private games, missing/invalid hand-start evidence or a missing/ambiguous seat yields NULL instead. A provable seat returns its club. The existing shared-union branch keeps its previous strict failure behavior. `rake_attributions.club_id` is nullable and has no default; the forward guard requires those properties. The captured three reporting triggers skip NULL clubs, and A's added source immutability trigger never replaces them with a host club.

RakebackSettler submits every cash source ID to `fn_credit_agent_commissions_batch` before any credit bucketing. The durable source worker calls the shared planner. A NULL club produces `cash_commission_attribution_incomplete`; an observed private earning club different from the bank host produces `cash_commission_earning_club_not_observed`. Both remain blocked work with an exact bank receipt, zero guessed commission/stats and no certified payout. This preserves the distinction between completing custody and approving an unsupported liability.

## Pending protected regression

Use the existing cash-source compatibility native profile's SQL stages, including its producer fixture and original-order probes. Then load the forward component and this folder's `regression.sql`. Do not modify or reinterpret the earlier component-A assertions as final-forward behavior: they describe its historical stage. The protected plan must bind all inputs and execute the final order. No direct runner invocation is authorized while the protected pipeline is unavailable.

The new six-case producer probe covers an observed cross-club private seat followed by re-seating, missing standalone seat, supported same-club private seat, missing hand-start evidence, conflicting overlapping seats and an overlapping unknown club. It calls the actual allocator, atomic bank producer, shared plan and durable source worker. Every bank deposit remains one chip to the host; the union bank does not move. Unsupported cases create durable refusal, the supported case accrues once, and both bank and worker retries preserve those outcomes. Shared-union missing/ambiguous provenance still refuses. The complete fixture transaction rolls back.

This bounded profile does not independently execute the whole F06 accepted-hand lifecycle. The source ordering and bank-preservation probe address the coupling without editing F06 writers; a final protected integrated hand/barrier replay remains necessary for acceptance. The original 59-source alert and its 118 unsettled commissions remain unchanged and require their own evidence-backed historical disposition.
