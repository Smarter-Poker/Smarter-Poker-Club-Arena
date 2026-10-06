# A spent reconnect grant does not fold a present player (2026-10-06)

## What was wrong

The reconnect protection deadline is an absolute instant, granted once per
absence and cleared by a voluntary action or by a hand ending while the player
is back. A player who dropped and returned earlier in a hand without having to
act carried that instant, long expired, into their own turn. A second short
drop on that turn was refused a new grant because one was still set, and
`rearmTurnTimerIfCurrent` then read `protection <= now` and force-resolved the
seat the moment the socket came back: a fold (a check if free) on a present
player, with the action clock unspent. A flaky phone with two short outages in
one hand is all it takes.

## The fix, at the cause

In `rearmTurnTimerIfCurrent` an expired grant that was made before the current
turn's clock began is treated as what it is, spent, and cleared
(`DisconnectEngine.clearSpentReconnectGrant`); the ordinary same-turn re-arm
then runs. The rule that an expired allowance cannot turn a heartbeat into a
fresh clock is unchanged for a grant made on the turn itself, and stays pinned.
After the clear, the next drop on that turn is granted afresh and is bounded
by that grant, so the path cannot be cycled to hold a turn open.

## Proof

`DisconnectMidTurnTimeBank.test.ts`: "a spent grant from before this turn does
not fold a player who is back", beside the existing "an expired allowance
cannot turn another heartbeat into a fresh action clock", which still passes.
