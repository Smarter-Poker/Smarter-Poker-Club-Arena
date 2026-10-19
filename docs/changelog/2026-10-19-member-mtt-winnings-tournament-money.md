# Member record and Player Statistics count tournament money, not tournament stack chips

The member record's MTT Winnings and Player Statistics' Net summed the signed results of tournament hands. Those are tournament stack chips, not money: a Club JAQK member showed MTT Winnings of -1,957,179 and a Net of -1,966,606 while the tournament money they actually paid and won (prizes paid minus buy-ins on the chip ledger) was -1,124.51, and the Win/Loss card already showed that figure.

`20261019095423` makes the record's `stats.mtt_winnings` read `ca_club_member_tournament_money` for the same club, member and UTC calendar range (from the start of the first day to the end of the last; an open end is unbounded). Cash winnings, hands, fees and transaction totals are unchanged. Record and Win/Loss "overall" now agree exactly.

`20261019095431` (built on `20261019021553`, which changed fees) makes Player Statistics' Net the cash hand result plus tournament money for the same range. For one game it adds only the money of that game's tournaments, joining the ledger leg's tournament to `tournaments.game_type`; its lower-case code is the code the daily facts store (checked on 1,861 tournaments with no mismatch). Hands, fees and every rate statistic are unchanged.

The Win/Loss readers timed out about 1,345 times in 24 hours because each member's tournament money read fetched every leg from the 7 GB ledger heap (3.3 s for a heavy member). `20261019095423` adds two partial covering indexes for exactly the two tournament legs, built concurrently through the migration applier's sanctioned preamble so live play is never blocked; the sum is now an index-only scan.

The Activity and Player Statistics help text now says what the figures are. The Data Console native check reproduces the stack-chip figures and proves record MTT = Win/Loss tournament money, statistics net = cash + tournament money for all games, one game and a UTC range, unchanged fees, hands and rates, and index-only legs.
