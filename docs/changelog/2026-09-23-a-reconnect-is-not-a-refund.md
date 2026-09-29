# A reconnect is not a refund

A backgrounded phone at a cash table is auto-folded every single hand, for ever.
It is never sat out, never evicted, and it keeps posting blinds the whole time.
That is live right now.

## The orbit

The away-blind budget is two slots, one small blind and one big blind. Spend
both while away and the seat is stood up and cashed out. It is the only rule
that eventually frees a seat whose player is gone but who keeps being dealt in.

`DisconnectEngine` refunded that budget - and reset the consecutive-timeout
ladder with it - on every reconnect EDGE, reasoning that "the blind cap is a
budget for ONE absence, they came back".

A frozen mobile tab produces one of those edges per orbit. The socket dies when
the OS suspends the tab and a beat lands when it wakes, and neither event
involves the person. So the ladder was zeroed several times an hour,
`maxConsecutiveTimeouts = 3` was never reached, and `awayBlindSbCharged` and
`awayBlindBbCharged` could never both be true at once. Every eviction rule that
could have freed the seat was disarmed by the same line.

This is the symptom the `AUDIT FIX 2026-07-19` note under `recordConnectedTimeout`
says was closed - re-opened by the one path that resets the counter it depends
on.

Both budgets are spent by ABSENCE and refunded by PRESENCE, and only a voluntary
action proves presence. `recordPlayerActed` clears all three, and so does
`sitBack`. The reconnect edge now clears none of them.

## The paperwork that outlived the hand

`reconnectDeadlineMs` is an ABSOLUTE instant, granted once by `markDisconnected`
and cleared in exactly one place - `recordPlayerActed`. `heartbeat()` does not
clear it, and `markDisconnected` refuses to re-grant while it is set. So a
player who dropped and came back WITHOUT taking a voluntary action - they
returned between hands, or the seat folded automatically while they were away -
carried an already-expired instant into every later hand.

`ServerTableEngineTurns` reads it on the reconnect path, sees
`protection <= Date.now()`, and force-resolves the seat the moment the socket
returns: a fold, on a hand the player is present for, with the full action clock
unspent. The absence was over hands ago; the paperwork was not.

A completed hand ends the decision the grant was protecting, so the grant ends
with it at `cancelAllCountdowns` - but only for a seat that is actually back. A
player still disconnected at the hand boundary is mid-absence and keeps counting
down the window they were given, or the ladder restarts from zero every hand and
the seat is protected for ever.

## Why it had to be restored rather than written

Both fixes shipped on 2026-09-09 and were lost on 2026-09-16, when `ea498c1fab`
returned the repository to its September 13 state. Nothing failed when they
went, because nothing pinned them. They are restored here byte-identical to what
shipped.

`tests/unit/reconnectDoesNotRefundAbsence.test.ts` is the missing pin. It walks
two orbits of a frozen tab - disconnect, blind charged, heartbeat, twice, with
no voluntary action anywhere - and requires the seat to be evicted. Against the
code that is live on main today, it is not: two of its five checks fail.

It pins the other direction too, because a fix that simply never refunds would
evict players who really did come back and play. A voluntary action still
refunds the budget, one slot alone still does not evict, and a seat that is
present at the sweep is never evicted no matter what it has spent.
