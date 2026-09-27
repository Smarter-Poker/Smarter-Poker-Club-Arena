# A Reviewed Void's Overlay Return Is Not Pool Money

The reviewed void of the retired events 615783bf and 5a387a75 (applied
2026-09-27 14:31/14:32 UTC) returned their guarantee overlays, 250.00 to club
2a1132b9's treasury and 100.00 to the union bank, as one `reversal` leg each
out of `prize_liability`. The ledger is neutral, but the escrow shadow
(`fn_ca_tournament_escrow_chips`) and the conservation delta
(`fn_tournament_conservation_delta`) did not know that leg and read the
returned overlays as money still in the pool: `fn_ca_escrow_balance_drift`
raised drift -250.00 and -100.00 at 14:35 UTC, and the hourly money
conservation check reads every cancelled event. Both readers now subtract the
reviewed-void overlay return. Migration `20260927150903`. No money moves.
