# Settled busts do not restart the tournament manager

The elimination stage retained a bust-wait clock after successful rebuys, authoritative decision omissions and successful knockout assignments. The assignment input array still included players whose elimination had already committed. Later cursor stages could consequently age a resolved bust past the existing 120-second recovery limit and request a successor manager.

Track the captured pending IDs and consume only authoritative receipts. Retire the clock when the captured work settles, refresh it for remaining work/proved future windows, and preserve unreadable/refused/malformed-window cases. A hand that completes while a read or assignment is awaited retains its first observation timestamp, so clearing the captured roster never erases newer work. Missing authoritative rows fail closed. The temporary observation belongs to the existing sweep and is cleared in its finally block. Financial writes, player treatment, database-owned rebuy deadlines and the existing recovery/silence limits are unchanged.

The regression executes the actual elimination stage and continuation: two rebuy paths and a successful assignment fail before their respective repairs. Thirteen cases cover receipts, later cursor stages, batching, future/malformed windows, unreadable rows, refusals and one/two real hand-completion callbacks during an awaited assignment. Existing successor-drain and rebuy guards remain required.

This prepared source repair is not itself evidence of the original production incident trigger or installation. Retain archived incident attribution, exact protected candidate checks, selected runtime release and stable-build natural live proof in the task checkpoint before claiming completion.
