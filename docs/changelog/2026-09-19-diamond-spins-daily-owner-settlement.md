# Diamond Spins daily owner settlement

Paid wheel entries and optional Double Down entries now move into durable daily
Diamond custody. Diamond prizes and the actual cost of Throwables, Time Banks
and Rabbit Hunts reduce that day's net. The current Union owner, or standalone
Club owner, receives one consolidated canonical Diamond wallet transfer after
the Chicago business day closes, with a statement and notification. Multiple
hosts belonging to the same owner share the daily transfer. A zero-net day has
a statement and notification without an artificial wallet movement.

Each authoritative spin transaction books immutable movements and the matching
daily totals together. The owner wallet serializes booking, settlement and
other spending. A negative daily position is fully backed by an owner wallet
reserve; a positive position reserves integer wallet capacity. A house edge
does not guarantee every day is profitable, so settlement never relies on that
assumption. Settled days and movement receipts cannot be rewritten. Repeated
settlement requests return the original receipt, including after waiting for a
concurrent attempt to commit. A notification failure rolls back the complete
settlement, including its wallet transfer.

The canonical Mint register retires inventory cost when awarded. Its existing
arena-custody balance and fixture split now include signed unsettled Spin
custody, preserving supply across entries, prizes and settlement. A claimed
tenth-day Daily Bonus still funds exactly 100 entry Diamonds from the Mint,
first issued and immediately transferred through the player's canonical ledger
to custody. A narrowly verified ticket-trigger exception prevents this fresh
Mint entry from consuming the player's previously purchased Diamond lots.
Claim preview creates no ticket or funding. Welcome spins retain no player
entry charge. Existing Promo-first and Main Bank chip payouts are unchanged.
Historical wallet receipts are untouched.

`fn_diamond_spin_statements(date)` reads only the signed-in owner's days, with
31-day cursor pagination, detailed income/expense totals and readable host
names. Direct custody table access and booking helpers are private. The two
settlement functions are service-only and preserve maintenance freezes.

The separately reserved schedule migration implements the explicitly requested
daily product at 00:05 America/Chicago. The verified GMT pg_cron clock checks
both UTC daylight-saving offsets, with only the real local 00:05 invocation
executing. Installation rejects an unexpected scheduler timezone or an
existing same-name job. Failed settlements report their error and remain
atomic; this adds no recurring repair or publishing mechanism.

Qualification uses the maintained PostgreSQL accounting runner after all prior
Diamond probes and the replay phase. Real authenticated wheel prizes, funded
Double Down, claimed Mint entry, welcome, owner isolation, supply conservation,
negative backing, private privileges, immutable receipts and forced partial
failure all pass with complete public/auth row rollback. A second disposable
database proves actual two-connection row blocking followed by exact replay:
one transfer, one statement, one notification and one outbox delivery. No
production wager, currency mutation or migration installation occurred during
this qualification. Source installation, cron readback and published UI remain
separate delivery evidence.
