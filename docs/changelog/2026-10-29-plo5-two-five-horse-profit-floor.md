# 2/5 PLO5 Horse departure floor

Owner request: Horses playing 2/5 PLO5 must not hit and run; they may voluntarily leave only after reaching 3.5 times their buy-in in profit.

The shared engine leave door now retains those Horses below the threshold, including session rotation, table changes, waiting-list yields and tournament departures. The persisted open cash-session baseline is the invested buy-in plus reloads; reloads cannot count as profit. A 500-chip investment requires a 2,250-chip stack (1,750 profit). The threshold permits departure; it does not force one.

The check waits until the Horse is outside a live hand and retains the seat if session cost cannot be verified. Forced system departures, bust-outs, other stakes/variants and human departures retain their existing behavior. No database money lock or new recurring job is introduced.

Regression coverage drives the real engine leave method with isolated database responses, including the cent below/exact/above boundary, reloads, unreadable cost, a live hand, system exits and scope exclusions. Production activation and behavior evidence remain separate from local tests.

Owner follow-up: Horses may stay beyond the profit floor. Their minimum entry/rebuy for this game is 500 chips, and the existing maximum-purchase policy remains the default for every eligible Horse. Tables with a maximum below 500 are declined, never overbought. Bankroll and table-limit checks remain authoritative.
