# tests/a-bank-that-is-short-pays-what-it-holds.law.test.ts

`fn_settle_tournament_obligation` refused the WHOLE payment when the escrow
bank could not cover the whole obligation, so a 180.00 shortfall became a
13,261.68 non-payment - and because the last place paid is always first place,
the winner always absorbed it. Three finished events were holding 21,419.57 for
three winners when this was found. A short bank now pays what it holds, never
more, leaves `amount_owed` untouched so the remainder stays owed and payable,
and says in its alert what it paid and what is still owed. Every other guard in
that function is asserted to survive the edit, which is made by substitution
against the catalogue rather than by retyping 15,900 characters of money path.
Who funds bubble protection - the 180.00 the pool promises twice - is Dan's
decision under 10.9 and is deliberately not made here.
