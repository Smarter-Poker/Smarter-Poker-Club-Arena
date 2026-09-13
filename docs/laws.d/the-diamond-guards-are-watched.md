# tests/the-diamond-guards-are-watched.law.test.ts

Phase 8's exit clause is "cannot pay playing-stack units to wallets", and the
audit says to mirror the chip guard that was added after 46.4 million chips
were minted into horse wallets. On the Diamond side that guard already exists,
on both axes, in every path that could turn a stack into wallet Diamonds:
cashout and settle_cash_hand refuse a tournament-attached table and refuse
custody that is not a cash seat, release refuses an active tournament entry,
and reserve sits behind tournaments_enabled. Nothing needed adding there.

What did not exist was anything watching those guards. fn_ca_guard_watchlist
named 28 functions whose definitions are hashed every hour so that an alarm
cannot be quietly disarmed, and not one of them was a Diamond function. Remove
one of the Diamond guards and nothing in the estate noticed. The same was true
of the four unit rules Phase 8 installed: they are pinned by laws that read
migration source and by vectors compared against generated output, and neither
sees a live redefinition in production.

The rule: the eight Diamond money doors, the four Phase 8 unit rules and the
watchlist itself are on the list, 41 names in all, and nothing that was watched
before is watched less. The thirteen are baselined through the estate's own
declaration door in the same transaction that widens the list, recorded against
this migration's name, so the watcher's next run has nothing to say and the
board shows who baselined them. The migration checks every name exists before
it widens anything, refuses to overwrite a baseline somebody else set, asserts
only its own thirteen quiet so another owner's open notice cannot block it, and
checks the list is still not executable without an account. The watcher is not
touched, muted or narrowed.

The companion change is in the declared-guard law: a guard is watched from the
migration that first named it, so the eleven earlier migrations that redefined
these functions before anything watched them are history for them, not
offenders. A migration owes a declaration only for a guard that was already
watched when it ran.
