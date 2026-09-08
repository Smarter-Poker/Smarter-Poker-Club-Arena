# 2026-09-08 - The diamond economy is measured, and two things were about to detonate

Five migrations, all applied to production and registered: `20260908050335`, `050354`, `050418`, `051206`, `051448`.

## 1. Two landmines dated 2026-09-14

Ruling 17's refusals flip on the 14th. Asking what the flip would actually do found two numbers that were right when nothing claimed and wrong now that horses claim.

**The per-user daily cap for `daily_challenges` was below what players complete.** It was 800. Measured over 14 days and 7,713 user-days of completions - the honest predictor of what a claim asks for, now that the engine claims the moment a challenge completes: **p50 195, p90 762, p99 1,357, max 1,726**. The cap sat between p90 and p99, so about one player-day in ten would have been refused and the worst would have lost ~900 diamonds it had earned. Set to **2,000**: above the observed maximum, so it never binds on real play while still catching a bug or a farm. Identical for VIP, because a cap is a limit and not a privilege.

**The `unclassified` budget line read 84,190 spent against a budget of 0** - an artefact of the 2026-09-07 restatement, not this month's issuance. Left alone, `DR7:engine_over_budget` was permanently true for that engine, so on flip day every unclassified row would have been refused by accident rather than by decision. Spend reset to 0; the budget stays 0, so the first genuinely unclassified row trips the alarm on its own merits.

## 2. The economy reads in one place

`fn_ca_diamond_economy(p_days)` - supply against the register, who holds it, faucets by engine, sinks by kind, the health number, liabilities, purchased-lot breakage by age, revenue, and the arena. `fn_ca_diamond_breakage_aging()` is the lot half on its own. Both service_role: this is the house's view of its own currency.

Its first live read, which is why it exists:

|                                 |                                           |
| ------------------------------- | ----------------------------------------- |
| Lifetime revenue                | **$2.00**, two purchases                  |
| Largest human holder            | 494,445 - **87.3%** of all human diamonds |
| Every other human (169 of them) | 71,801 between them                       |
| Faucet, 30 days                 | 19,865                                    |
| What players spent playing      | **2,873**                                 |
| Health number                   | **6.91**                                  |
| Unclaimed challenge liability   | 2,265,372 over 36,437 rows                |

## 3. Three standing nets

- **Concentration and velocity** (`fn_ca_diamond_economy_watch`, daily 06:25 UTC): files `DR13` when one account holds more than 60 percent of human diamonds, or issuance outruns player spending by more than 20x. Both thresholds derived from today's figures with the measurement beside them. Its first run filed one incident: concentration 87.3.
- **Retention** (`fn_ca_diamond_prune_history`, daily 06:40 UTC): `ca_diamond_incidents` took 2,447 rows in 24 hours with no retention at all, and `user_daily_challenges` grows 5,000-8,000 a day. Only **resolved** info and warning incidents, and only **claimed or expired** challenges, are removed; nothing unresolved and nothing owed. There is a floor the parameters cannot argue past.
- **Reachability** (`fn_ca_diamond_unreachable_money`): the fourth class of the trap that produced four defects tonight - a money function with no caller, a client-reachable path the privileged-column guard would refuse, and a rule nothing consults.

**Its first run found `fn_add_diamonds`**: a function that credited a wallet with no payment, no reference and no journal class - the "development fallback" inside `DiamondService.purchaseDiamonds`. It never worked, and only because the grant was absent. Its client half had been removed on main earlier the same day, leaving it with no caller anywhere. Dropped in the same migration that found it.

## 4. The health number was wrong twice, and both times its own output said so

First read: **1.15**, which says the currency is nearly balanced. It is not. Of the 16,993 counted as spending, **14,120 were five admin adjustments** - the house correcting its own books.

First correction excluded `issuance_class IN ('admin','refund')`. Applied, it returned 16,993 again: those adjustments are historical rows written before the classifier, and their class is **NULL**, which the exclusion let through. Classifying by a column that is empty on the rows in question is a guess dressed as a rule.

Second correction uses the register's own authority, `fn_ca_diamond_journal_origin`, which reads the kind rather than the class: adjustment 14,120, spend 2,670, bridge 203. Player spend **2,873**, health number **6.91**. The alarm reads the same function, so the two can never disagree, and the migration asserts the separation on live data rather than trusting it.

**The lesson, for the third time tonight: a definition is only true of the rows it was tested on.**
