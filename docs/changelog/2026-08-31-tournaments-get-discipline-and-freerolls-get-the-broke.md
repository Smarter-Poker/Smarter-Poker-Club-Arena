# 2026-08-31 — Tournament entry gets discipline, and freerolls get the broke horses

Phase 3 of the bankroll re-land, recovered from `6eae5e2b90` (#2118).

## The two defects

**Tournaments had solvency, not discipline.** `fn_register_horse_for_tournament`
refuses on `insufficient_balance` and nothing else, so a horse with 1,000 chips
to its name could enter a 950 event and be broke on one hand of it.

**Nothing preferred a broke horse for free money.** The recovery loop Dan
described — "if they run out of chips, they must play freerolls to earn their
chips back, and wait for their weekly rakeback" — had no implementation at the
freeroll end. The hourly rotation picked by id, so the horses that most needed
a freeroll were no likelier to get one than anybody else.

## The bar, and why it is so much higher than the cash bar

nit 100 buy-ins, standard 60, gambler 30, priced on the FULL entry including
fee. That is variance, not caution: a cash session is a shallow continuous
distribution where a bad night costs a couple of buy-ins, while a tournament
pays nothing to most of the field most of the time, so a roll that comfortably
survives 25 cash buy-ins is busted by an ordinary run of 25 min-cashes. The
textbook figures are 20-40 buy-ins for cash and 100+ for MTTs.

Pricing on buy-in plus fee matters because the fee is what leaves the wallet;
pricing off the prize contribution alone understates a turbo's real cost by its
whole rake.

## No starvation, measured against production rather than assumed

Re-measured today rather than inherited from the handoff:

- Every event scheduled in the next 24 hours costs between 0 and 25 chips
  (4 freerolls, then tiers at 1, 2, 3, 5, 10, 15, 20, 25).
- The minimum live roll across all 1,487 horse club memberships is 11,800
  (p10 24,890, median 33,375), read from `club_members.chip_balance` — the LIVE
  pool, not the frozen `public.wallets`.
- The strictest bar in play is the nit's 100x at the 25 tier, which needs 2,500.
  All 1,487 memberships clear it.
- After the 10,000 reset the nit still clears every scheduled tier; the first
  tier that would bite a nit is 100, and none is scheduled.

## Fails open, in three places

An unreadable roll, an incomplete page, or a thrown read each leave the pool
exactly as it was. Refusing to register on a failed read would silently starve
every event on the platform — the same one-line inversion that emptied the cash
floor for forty minutes on 2026-08-31, in a different file. Each of the three is
pinned separately.

## Freeroll routing

Broke horses move to the front of the queue, stable within each group so the
hourly rotation still spreads who leads it. "Broke" is measured against the
cheapest PAID event actually on the board, never a constant: a hard-coded floor
goes stale the day the schedule changes, and the question being asked is exactly
"is there a paid game this horse could be playing instead?" If that read fails,
nobody is marked broke and the order is left alone.

## Telemetry

`tournament_refused_underrolled` and `freeroll_entered_broke` join the event
union. The dead-vocabulary pin from Phase 2 caught these immediately — it
scanned only the fleet manager and the rotator, and the new emitter is the
tournament service — so its emitter set was widened rather than the assertion
weakened, and it was re-mutated afterwards with an unemitted name and went red.

## Pins

`server/src/services/HorseTournamentBankroll.test.ts`, 13 assertions. Nine
mutations applied and observed failing, then reverted: a freeroll gated;
an unread roll removing the horse; an incomplete page still filtering; the
rotation reading the ungated pool; broke horses no longer moved to the front;
broke measured against a hard-coded floor; cost priced on buy-in alone, dropping
the fee; the tournament bar loosened below the cash bar; the read error
swallowed instead of reported.

server 3112/276 green, client 10289/732 green, both tsc clean.
