# Independent Next-Hand Reads Run Together

The dealing loop loaded the fresh roster, refreshed tournament blinds, and
refreshed cash rake configuration sequentially. When configuration was due
for refresh, every database round trip extended the gap before the next deal.

`readNextHandInputs` starts the existing reads together after the settlement
barrier and deliberate pause gate. Each read retains its named timeout budget.
The method waits for all three budgeted reads to settle, propagates a failure,
and returns a roster only when all inputs succeeded. This avoids starting a
new iteration while another budgeted read is still pending.

Blinds and rake refresh do not consume the roster. Their existing tournament
and cash guards, refresh throttles, queries, and configuration assignments are
unchanged. Presence restoration follows the successful roster assignment.
The engine reports `load_next_hand_inputs` while this work is pending.

The change overlaps independent reads; it does not cache stacks, bypass
settlement, remove the rabbit-hunt window, shorten completion animations, or
change rebuy decisions. Remaining settlement and other pre-deal work still
contribute to hand spacing and require separate measurement.

Three behavioral tests cover concurrent admission, waiting for the last input,
and draining other budgeted reads before propagating a roster failure. The
sequential version failed the concurrency and failure-drain cases. The focused
engine run passed 30 tests. The complete server suite passed 6,486 tests
across 457 files, and the server TypeScript check passed.
