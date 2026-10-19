# Player Statistics Net counts tournament money, not tournament stack chips

Player Statistics' Net summed the signed results of cash AND tournament hands. The tournament half is stack chips, not money: a Club JAQK member showed a Net of -1,966,606 while their Win/Loss net (cash result plus tournament prizes minus buy-ins) was -10,551.

`20261019143456` (built on `20261019021553`, which changed fees) makes Net the cash hand result plus `ca_club_member_tournament_money` for the same club, member and UTC calendar range, the Win/Loss definition. The member record's MTT Winnings already reads the same money (`20261019095423`), so record total plus MTT winnings, Statistics Net and Win/Loss net now agree. For one game, Net adds only the money of that game's tournaments, joining the ledger leg's tournament to `tournaments.game_type`; its lower-case code is the code the daily facts store (checked on 1,861 tournaments with no mismatch and 1.4M recent legs with no missing tournament or unknown code). Both legs read the covering indexes from `20261019095423`. Hands, fees and every rate statistic are unchanged.

The Player Statistics help text now says Net is cash result plus tournament money. The Data Console native check proves Net for all games, one game and a UTC range, unchanged fees, hands and rates, and replay refusal.
