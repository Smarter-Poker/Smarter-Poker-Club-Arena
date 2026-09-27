# Departure fixture reads drained process output

The disposable PostgreSQL cash-departure fixture now waits for the child process
`close` event before returning its rejection text or rejecting missing readiness.
The previous `exit` listener could resolve before the stderr pipe drained, producing
an empty error despite PostgreSQL rejecting the transaction with `CASH_PURCHASE_ONLY`.
This follows the same boundary already used by the adjacent concurrent SQL helper.

Two controlled child-stream sequences reproduce both old failures through the
actual holding helper: exit before late stderr, and exit before late readiness.
The original 166 native cases, five-second SQL budget, money assertions and
one-time commit/rollback command remain unchanged. No production SQL changed.
