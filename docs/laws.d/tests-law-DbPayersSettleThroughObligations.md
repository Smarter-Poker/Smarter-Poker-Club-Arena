# tests/law/DbPayersSettleThroughObligations.law.test.ts

Every DB-side tournament payer settles through fn_settle_tournament_obligation and never credits a wallet itself; the settle key names the tournament; the R3 money-path trigger is log-only
