# tests/a-diamond-bounty-is-paid-from-its-own-bank.law.test.ts

Phase 8 decomposed every Diamond entry into prize, bounty and fee parts and
summed them into three banks (fn_poker_diamond_tournament_escrow), but it
refused the bounty bank at three doors by name: the charge would not carry a
bounty part, the drain knew only the prize and fee banks, and the payer
refused the bounty category. The chip estate's knockout machinery - the
engine's claim from hand evidence, fn_collect_bounty with its PKO half rule
(half to the collector's wallet, half onto their head, floored to the unit),
fn_finalize_bounty_pool paying the champion's own head and any residual at
the terminal - is unit-aware since September 12 and is reused whole. What it
lacked was a Diamond reading of "how much of the bounty pool has been paid":
it took that from wallet_transactions rows a Diamond payment never writes,
which would have read a Diamond pool as never paid.

Migration 20260914111709 opens the bank. The drain holds the bounty bank per
custody row exactly as the prize and fee banks (the row's bounty parts less
what the bounty bank already drained from it). The payer pays category
'bounty' from that bank into the collector's wallet, writes a 'bounty' ledger
row and applies bounty_out to the escrow shadow - which it opens first from
the ledger's exact parts, because a knockout is paid mid-event, before the
terminal would have opened it, and the chip shadow's "first sight" opening
splits refunds by proportion. The charge carries a bounty part and, once the
shadow is open, applies every later inflow (a late entry, a re-entry, a
rebuy, an add-on) to it. The creation door admits 'bounty' and
'progressive_bounty' under the chip door's rule: a whole bounty of at least
one Diamond, no larger than the buy-in after the fee; mystery bounties,
satellites, spins, guarantees and free entries stay refused by name, and a
bounty on a non-bounty format is refused. The registration core's Diamond
roster row carries the head, so the roster trigger does not seed it a second
time and raise an alert. Six chip readers learn the Diamond ledger in place:
fn_collect_bounty (what the pool still holds), fn_finalize_bounty_pool (what
was paid, so the residual is exact), the terminal writer (its bounty evidence
before and after the close), fn_payout_guarantee_check (the board's bounty
shortfall watch) and the terminal receipt reader (the pool closed exactly).

Nothing is priced here: the bounty is what staff enter, the split is the chip
rule, the fee is the rule the recovery fee states. The law reads each section
by its heading and pins the mechanics: the Diamond doors pinned, redefined
with the same signature and declared to the guard watch; every chip edit an
asserted substitution with its live md5 and reverse proof; the readers each
keeping their chip reading beside the Diamond one; and the closing assertions
(no door refuses the bank by name, no door is a browser door, the settlement
steps stay owner-only, the identity is whole, every watched guard on its
baseline, the switch off).

Rehearsed through the real doors in one rolled-back transaction before the
apply: a progressive-bounty event created (99 + 11 fee, bounty 40; a mystery
event, a bounty on an MTT and a bounty above the buy-in all refused by name);
three entries as clients (59/40/11, heads on the roster, pool 120, no second
seeding); one withdrawal whose refund carried its bounty part, and a return;
the launch; a knockout collected by the estate's own collector (20 to the
collector's wallet from the bounty bank, 20 onto their head, the ledger row,
the shadow opened exactly); a Diamond rebuy through the purchase core proving
a bought-back generation on real rows; two more knockouts; the terminal
paying the place from the prize bank, the champion's own head from the bounty
bank and the fee to the house, every bank and the custody at zero, the
identity unmoved; and a replayed terminal paying nothing.
