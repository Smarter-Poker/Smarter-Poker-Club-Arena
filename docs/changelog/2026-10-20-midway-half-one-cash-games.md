# Midway $0.50/$1.00 cash games

Owner request October 20: add $0.50/$1.00 No Limit Hold'em and PLO4/PLO5/PLO6/PLO Hi-Lo in Classic, Action and Madness. Games belong to Midway Union and retain the existing member-club and horse access paths.

The shared picker already offers these blinds. Midway's NLH/PLO4/PLO5/PLO6 catalog skipped this rung, while the Action/Madness unique band guard grouped it with $1/$2. Give only Midway's requested variants and exact $0.50/$1.00 pair a dedicated catalog category. Keep horse stake bands, the other four categories, other hosts, exact-stake duplicate protection and existing games unchanged. The picker uses the same category rule with the resolved host UUID.

The migration atomically installs a replacement unique index and matching trigger with bounded lock/statement timeouts. The existing service-only `fn_cash_game_ensure` creates or reuses the requested games and their Main 1 tables; repeated operations read existing identities first. No wallet, seat or hand-history changes are part of this assignment.

Local verification: native PostgreSQL reproduced the old duplicate-band refusal, then accepted all 15 variant/style combinations alongside $1/$2; all 10 Action/Madness duplicate cases still refused, other hosts remained restricted and horse band classification stayed unchanged. Focused client vocabulary/category tests passed (85 assertions). Hosted checks, installation and live catalog proof are tracked separately in the task checkpoint.
