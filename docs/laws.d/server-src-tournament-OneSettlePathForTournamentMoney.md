# server/src/tournament/OneSettlePathForTournamentMoney.law.test.ts

One settle path for tournament money: only settleObligation.ts may credit a player from a tournament (fn_settle_tournament_obligation); a refused settle raises a critical alert and never throws
