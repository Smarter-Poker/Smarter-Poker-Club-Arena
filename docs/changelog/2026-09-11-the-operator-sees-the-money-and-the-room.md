# The operator sees the money and the room

**2026-09-11. Phase 3 of 6.**

Continues `docs/changelog/2026-09-11-the-welcome-spin-answers-the-same-everywhere.md`.

## The two questions the consoles did not answer

**"What did this earn me?"** Balances are a photograph. The realised-return
windows are about fairness rather than money: they say what fraction of the
intake came back out as chips, and they do not count the diamond prizes at all.
So the one figure an owner cares about, whether they are up or down, appeared
nowhere on either console.

**"How close am I to it stopping?"** The cover reading goes red at zero. By then
the games have been refusing bets for a while, because every game caps the
multiplier it will offer by what the cover can pay. There was nothing between
"fine" and "stopped".

## Three reads, and nothing that runs on a schedule

CLAUDE.md 10.12 forbids a monitor, a watch or an alert presented as the
resolution. These are not that: they are computed when the operator opens the
page they already open, out of the rows the games already wrote. No cron, no
table, no job.

**`fn_diamond_game_pnl`** states the net as arithmetic on money that actually
moved:

    net = intake / rate - chips paid - diamonds paid / rate - welcome chips

over four windows, with a per-game breakdown. The welcome spins are separated
out rather than buried, because they are a gift the host chose to make and an
owner should be able to see what it cost without mistaking it for the paid game
losing money. Fixture and certification accounts are excluded throughout;
horses are not, because a horse is a player (CLAUDE.md 10.5) and its diamonds
are real. An open crash round is excluded from every window: it has taken the
bet and not decided the payout, so counting it would report a profit that has
not happened yet.

**`fn_diamond_game_room`** gives the biggest win a player could take right now
at the largest bet, against the ceiling the configuration allows, and a state
word: open, thin, stopped. The number comes from `fn_diamond_game_cap_cents`,
the same function the door uses, so the console cannot say one thing while the
game does another.

It also says **which** ceiling is binding, and that distinction is the whole
value of the reading. `fn_diamond_game_cap_cents` takes the least of three
things: the configured ceiling, the intake headroom and the cover. Asking it a
second time with a bank nothing could exhaust isolates the first two. The intake
headroom binding means the game has not taken enough in yet to risk a payout
that size, which is the never-pay-more-than-taken-in law working exactly as
intended and nothing to act on. The cover binding is the operator's to fix.

The first cut of this reported them as one number, and the probe caught it
calling a fully funded plinko "thin" on a host with 20,000 chips of cover. That
would have told an owner to move chips they did not need to move.

The wheel is stated in its own terms, because its prizes are a fixed table
rather than a multiplier: the top chip prize and whether the cover covers it,
and the top diamond prize and whether the **owner's** diamonds cover it, which
is a separate way for the wheel to go thin that no chip reading would show.

**`fn_diamond_game_players`** lists today's players against the two daily
ceilings, with what they spent and what they won. Per-player caps have existed
since the games opened and no surface ever showed an operator who was near one.
"Today" is the America/Chicago day the caps themselves are counted on, so the
console and the door agree about when the day turns.

## One component, both consoles

`DiamondGamesMoney` renders all three on the painted chassis and is used by the
wheel page and the games page, so they cannot drift apart. The first render put
"Biggest Win Now" and "Ceiling" in adjacent columns of a four-column grid at
393px and they collided; the header is "Top Win" now and the copy above the
table says what it means.

## Verified

A rolled-back probe on both host shapes. It asserts that a plain member reads
none of the three, plays six real plinko drops, and then asserts the 24 hour
window moved by exactly those rounds, exactly those diamonds in and exactly
those chips out, that `net_chips` is the sum of its own terms, that all four
windows are present and All Time is no smaller than 24 Hours, and that the
per-game breakdown names the game that was played. It then squeezes the cover
and reads the room open, thin and stopped in turn, checks that a fully funded
game does not claim the cover is capping it, and asserts the wheel's two
coverage flags agree with the cover and the owner's balance. Finally it finds
the player who just played in the list, with their name, their rounds and their
spend, and flips the daily ceiling to prove the cap flag turns on.

`profiles.diamonds` is server-managed and a probe may not lower it, so the
owner's diamond side is asserted as a relation the function must hold rather
than by forcing a balance.
