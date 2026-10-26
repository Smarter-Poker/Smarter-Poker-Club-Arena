# Capacity admission rechecks terminal state after a database wait

The #8199 freeze repair correctly bypasses the sweep work budget, but checked
finished-event flags only before reading pending capacity receipts. If a terminal
callback completes while that query is in flight, the subsequent admission could
start a dealer for an event that has finished. The shared admission predicate now
checks both terminal flags at every existing lifecycle boundary, including after
the receipt query and acknowledgement. Stop, abort, freeze and budget-independent
admission behavior are preserved.

The regression drives the real admission method and sets each terminal flag while
the receipt query is in flight. It fails before this change and passes afterward.
No schema, money, seat, timer or release-route changes are required.
