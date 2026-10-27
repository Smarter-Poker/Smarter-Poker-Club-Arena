# Expired break presentation retires at its countdown boundary

An ended tournament break could leave the full popup or minimized 0:00/Paused button over ongoing play until a reconnect or a delivered end broadcast. The presentation now disappears when its countdown reaches zero. This does not resume any table or change the engine's independent pause authority. Last-hand mode still waits for this tournament's authoritative countdown.

The hook performs one durable read at the original deadline and another when the page becomes visible. The existing tournament row UPDATE subscription refreshes break state too. Existing owner/revision fencing prevents stale reads from overriding newer events or following a player to another tournament. There is no polling repair loop or production financial write.

Regression coverage drives full and minimized expiry, delayed ticks, last-hand state, one boundary read without repetition, foreground recovery, unreadable rows, missed broadcasts and lifecycle races. Source-contract and TypeScript results and delivery evidence live in CHECKPOINT-expired-break-freeze.md. Frozen late-registration tables are separately investigated there; popup retirement alone is not a dealer repair.
