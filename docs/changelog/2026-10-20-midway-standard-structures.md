# Midway tournament structures and Free Buy guarantees

The Free Buy generator halved a 25 big blind with Math.floor, producing 12/25.
Other Midway templates combined 3,000-8,000 stacks with accelerating turbo
ladders and 8-10 levels of late registration, admitting players with as little
as 0.6-8 big blinds. Rebuys could close before late registration, and template
add-ons did not consistently scale with starting stacks.

The original scheduled creator now applies one Midway structure policy before
insertion, for both fixed-board and configured schedules and new manual repeats.
Openings are 25/25, 25/50, 50/100, 75/150 and 100/200. All 40 levels use
conventional whole denominations. Turbo, regular and deep clocks stay fixed at
5, 8 and 12 minutes. Paid stacks round upward to a 5,000-chip denomination;
late registration closes with at least 20 starting-stack big blinds remaining.
Rebuys grant one starting stack through that same cutoff. Paid add-ons grant
at least two starting stacks, with one add-on period and a five-minute break.
NLH uses one full big-blind ante beginning at level 5; Omaha uses no ante.
AnteMath already recognizes an authored full-BB ante as one total, not one per
seat, so that existing engine contract is preserved.

Five six-card Omaha schedule definitions advertised nine seats even though
the launcher correctly caps those tables at seven for deck capacity. New
rows and their schedule metadata now use that same arithmetic ceiling. The
separate cash-game seat policy is not applied to tournaments.

The runtime audit also found paid add-on windows hard-coded to 60 seconds
despite a longer configured break. The original durable-window calculation
now uses that configured duration. A real-manager regression reproduced
five- and ten-minute offers being truncated to one minute before the fix;
after it, persisted deadlines and broadcasts match one, five and ten minutes,
duplicate openings do not extend the window, and Free Buy's early hour plus
its break remains intact.

Free Buys retain the owner's 3,000 starting stack, 10,000 add-on, one-chip
rebuy/add-on prices, early add-on availability and one-hour registration.
Five 12-minute levels make that hour explicit. At the last admitted level the
original stack has 15 BB, or 65 BB with the add-on. The owner's October 20
correction sets 8:30 AM to 250, 8:30 PM to 500, and 12:30 AM to 250; their
times stay unchanged. Other prices, guarantees, bounty allocations and times
are preserved. The existing Free Buy audit reads the revised structure and
its per-slot guarantee while retaining historical contracts.

The single data migration updates the active schedule configurations, refuses
concurrent configuration drift, and updates only unregistered future events:
no actual entrants, no locked entry contract, no finalized pool, and zero
stored players. Existing registered/live events retain their advertised terms.
No wallet, player stack, escrow, payout or ledger write is introduced. The
ongoing mechanism is the original spawn path, not a new repair timer.

Validation: all 145 live schedule definitions pass through the actual creator
in regression tests. Native private PostgreSQL qualification exercises 145
eligible events plus 725 protected cases (actual entrants despite a stale zero
count, running, another club, finalized, entry locked), a no-op replay and
concurrent configuration drift refusal. Run from the repository root against
an explicitly started owned SSD PostgreSQL instance:

```
node server/qualification/midway-structures/qualify.mjs SSD_SOCKET PORT SSD_WORK
```

Real rooms publish event-specific structures rather than one universal stack
or speed: PokerStars explains that entry, rebuy and add-on stacks are tailored
to the event, and that add-ons follow the rebuy period. The values above are
Midway's owner-directed operating policy, not a claim of a universal poker rule.
References: https://www.pokerstars.com/poker/tournaments/types/ and
https://www.pokerstars.com/help/articles/trn-rebuy-addon/137378/.

Delivery state and exact production evidence are recorded in the task checkpoint.

The Mid-Morning Turbo (6-Max NLH) also publishes and creates six-seat tables, matching its advertised format.

Owner follow-up removes the Midway 11 AM Coffee Break Freeroll. The board owner retires it, the creator refuses stale copies, and installation deactivates its schedule. Diamond Arena is unchanged. The revised Midway schedule has 144 definitions and 350 weekly starts.
