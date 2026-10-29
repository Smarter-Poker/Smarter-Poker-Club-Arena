# Explain seat moves to the source table

The serving engine already broadcasts a committed `seat_moved` event to every source-table subscriber, including both sides of a swap. The client followed the moved player's chair but gave remaining players no explanation, making a transfer look like a cash-out.

The client now prints a system chat entry and a table notice naming the player and destination. Main-game moves say “Was Moved To The Main Game”; other transfers name the destination table. Names use the same poker-alias resolver as the roster, never legal-name columns. A cached source roster preserves the departing alias after its seat disappears. Failed reads retain truthful generic destination text and report diagnostics.

Replayed history, duplicate delivery, uncommitted notices and events for another table do not announce. Late reads cannot write into a different table or an unmounted view. Navigation and financial state are unchanged. This uses the existing serving-engine API and requires only client publication.

Regression protection covers main and requested moves, roster removal, swap partners, replay/foreign-event rejection, duplicate StrictMode delivery, late reads and read failure. Existing navigation regressions remain required alongside compilation, normal hooks, protected delivery and production interoperability.
