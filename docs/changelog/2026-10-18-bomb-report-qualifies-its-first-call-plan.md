# Bomb reports retain the qualified plan from the first call

JAQK still timed out after the bitmap setting: its custom plan selected the table/hand-number index and took 9184ms. The same parameterized generic plan uses the table/created-at index and took 142ms. The catchup function now selects the qualified generic plan on its first invocation, preserving its exact SQL body, private grants, archive and rollup producer.

The existing required PostgreSQL report qualification checks the unchanged body, function-local settings and restoration, private caller authority and replay refusal. Actual authenticated report reads remain required after guarded installation. No engine or client change is needed.
