# Member record MTT Winnings count tournament money, not tournament stack chips

The member record's MTT Winnings summed the signed results of tournament hands. Those are tournament stack chips, not money: a Club JAQK member showed MTT Winnings of -1,957,179 while the tournament money they actually paid and won (prizes paid minus buy-ins on the chip ledger) was -1,124.51, and the Win/Loss card already showed that figure.

`20261019095423` makes the record's `stats.mtt_winnings` read `ca_club_member_tournament_money` for the same club, member and UTC calendar range (from the start of the first day to the end of the last; an open end is unbounded). Cash winnings, hands, fees and transaction totals are unchanged. Record and Win/Loss "overall" now agree exactly.

The Win/Loss readers timed out about 1,345 times in 24 hours because each member's tournament money read fetched every leg from the 7 GB ledger heap (3.3 s for a heavy member). The same migration adds two partial covering indexes for exactly the two tournament legs, built concurrently through the migration applier's sanctioned preamble so live play is never blocked; the sum becomes an index-only scan.

The Activity card help text now says MTT Winnings is tournament money. The Data Console native check reproduces the stack-chip figure and proves record MTT = Win/Loss tournament money for overall and UTC day ranges, unchanged cash, hands and fees, and index-only legs.

Player Statistics Net follows in a separate change once `20261019021553` (fees) is installed, because it patches the definition that migration produces.
