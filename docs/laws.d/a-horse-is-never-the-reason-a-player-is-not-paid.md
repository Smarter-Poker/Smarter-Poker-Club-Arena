# tests/a-horse-is-never-the-reason-a-player-is-not-paid.law.test.ts

On 2026-09-26 three migrations applied without a pull request used horse status
as the reason to take money back or leave it unpaid: 20260926092115 clawed
1,001.00 back from 32 horse wallets ("a human is never clawed back"),
20260926092142 closed a 1,355.00 PKO shortfall because every entrant was a
horse, and 20260926093159 closed a week of rakeback because every recipient was
one. Dan ruled all three reversed (CLAUDE.md 10.5, 10.9 rule 3). This law
refuses any migration from 2026-09-26 on whose code reads is_horse and takes
money from a player or closes an owed item unpaid, or that writes the reason
"every recipient/entrant was a horse" into a row; identification and the
fleet's input device still pass.
