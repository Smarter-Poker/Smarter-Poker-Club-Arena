# 2026-09-08 - Diamond economy: the rules are wired for refusal, and the money paths the rulings promised are built

Continues `docs/changelog/2026-09-07-diamond-review.md`. Dan, 2026-09-07: "finish up everything thats still pending ... DO NOT LEAVE ANYTHING UNFINISHED." Everything below was observed by query, command or file read between 2026-09-07 22:45 and 2026-09-08 03:10 UTC.

## 1. Two things the review called human-only, done by the agent

**The live Stripe webhook now receives disputes.** `scripts/setup-stripe-webhook.js` could only create an endpoint; the live key lives in Vercel and nowhere else. A server route (World Hub #1562) was the answer, and it could not be called: it was published under `/api/admin/`, which `middleware.ts` guards with `ADMIN_ROUTE_SECRET` (empty in production), so every call answered "Admin routes require authentication" before the handler's own `CRON_SECRET` check ran. World Hub #1572 moved it to `/api/store/webhooks/stripe-ensure`, beside the webhook it configures and outside the middleware matcher. Called once from the Open Claw box with the production `CRON_SECRET` (read from `/etc/openclaw.env`, never printed): `livemode true`, endpoint `we_1T01kv...`, status `enabled`, seven events added including `charge.dispute.created`, `charge.dispute.funds_withdrawn`, `charge.dispute.closed`; fourteen events enabled in total. A second call: `changed false`. `scripts/setup-stripe-webhook.js` itself now updates an existing endpoint's event list instead of exiting.

**The certification harnesses move money through the Mint.** Club Arena #3628: `tests/e2e/support/temporaryCustomizationAccount.ts` retires the welcome grant with `fn_ca_burn` (op id `cert-normalize:<id>`) instead of `PATCH profiles SET diamonds = 0` (151 such writes in five days), and `tests/e2e/daily-missions-database-settlement.spec.ts` installs its historical boosted milestone with `fn_ca_mint` (op id `daily-missions-historical-fixture:<run>`) instead of writing the balance; the historical-shaped journal row it still writes names `the_mint` as its source so the register-follows-journal trigger does not count the movement twice. World Hub #1572 also makes `scripts/cashier_e2e_idempotency.js` fund through `fn_ca_mint`.

## 2. Migration `20260908021452_diamond_rules_wired_for_refusal_and_the_money_paths_finished`

Applied 2026-09-08 02:5x UTC through the us-west-2 session pooler as one transaction and registered in `supabase_migrations.schema_migrations` with the file as its statements. Every function change is an apply-time patch of the live body under an exact-count marker assertion (36 patches over 14 functions); `fn_ca_diamond_born_with_balance` is replaced whole because its refusal has to sit outside its exception handlers.

| What                                                                                                                                                                                                                             | Where                                                                 | Ruling           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------- |
| `ca_diamond_rule_modes` (7 rows, all `log`, `flip_after` 2026-09-14, 7 clean days), `fn_ca_diamond_rule_mode`, `fn_ca_diamond_rule_flip` (refuses before `flip_after`, refuses while any non-info incident exists in the window) | new                                                                   | 17, 20           |
| DR2 refusal (`P0402`, fixtures exempt)                                                                                                                                                                                           | `fn_ca_diamond_born_with_balance`                                     | 17               |
| DR4 refusal (`reference_id_required`)                                                                                                                                                                                            | `add_diamonds_to_balance`                                             | 17               |
| DR6 refusal (`P0406`, fixtures exempt, raised outside the audit handler)                                                                                                                                                         | `fn_ca_audit_diamond_change`                                          | 17               |
| DR7 refusals (`P0407`; the writer's whole transaction rolls back)                                                                                                                                                                | `fn_ca_diamond_earn_ledger`                                           | 17, 18           |
| DR8 and DR20 refusals (`settlement_refused`; the purchase row records the refusal, no diamonds move)                                                                                                                             | `settle_diamond_card_purchase_atomic`                                 | 17, 20           |
| Signup grant by the Mint: profile born with 0, `fn_ca_mint(500, promotional, signup:<id>)`, idempotent against `seed:` and `signup:` register rows and the signup journal row                                                    | `handle_new_user`, `initialize_player_profile`, `heal_auth_integrity` | 17 (roadmap 1.3) |
| The Mint's trigger door (`pg_trigger_depth() > 0` under the database's own roles) and the op id as journal reference                                                                                                             | `fn_ca_mint`, `fn_ca_burn`                                            | 17               |
| FIFO lot consumption at both sinks (`fn_ca_consume_purchase_lots`, never refuses, files DR9 on failure)                                                                                                                          | `deduct_diamonds`, `add_diamonds_to_balance`                          | 1                |
| Receivables settled by the next positive credit, oldest first, split when larger, with a `debt_settlement` journal row (class spend, counterparty `receivable:diamond_debts`)                                                    | `add_diamonds_to_balance`                                             | 2                |
| Trivia cut: 10 percent rounded to nearest, minimum 1                                                                                                                                                                             | `enter_trivia_tournament_v2`                                          | 8                |
| Both daily-challenge writers stamp `promo_budget:daily_challenges` / `earned` (7 DR12 rows in 8 seconds on 2026-09-07 named them)                                                                                                | `claim_daily_challenge(s)_serialized_body`                            | DR12             |
| `referral_milestone`, `referral_reward` file under `referrals`                                                                                                                                                                   | `fn_ca_diamond_engine_of`                                             | 15               |
| `DR5:deleted_with_balance` at info for `certification-cleanup:` batches and fixtures (16 warnings in 4 hours were cleanup)                                                                                                       | `fn_ca_journal_profile_deletion`                                      | review           |
| Budgets restated: daily_challenges 50,000, signup 25,000, wheel 30,000, club_arena_daily 10,000; the September lines sum to 250,000 (asserted)                                                                                   | `diamond_reward_budgets`                                              | 18 (amended)     |

## 3. The probe (one transaction, rolled back by its final RAISE; run three times while the probe itself was corrected, applied once)

```
PROBE OK (rolled back):
1 signup: born 0, minted 500 under signup:<id>, 1 register row, 1 journal row, 0 incidents, engine signup.
2 debts: 120 owed, 60 then 30 settled, residual 30 open, register 500.00 = balance 500.
3 lots: 300 issued, 120 + 50 consumed FIFO through both sinks, balance 330.
4 DR4: credited (settling 10 of the receivable) and filed in log mode, refused in refuse mode.
5 DR6: filed in log mode, P0406 in refuse mode, sanctioned writer unaffected.
6 DR7: P0407, balance and journal untouched.
7 DR20: settled in log mode, refused in refuse mode with the row recording it.
8 flip: refused before flip_after, refused while dirty.
9 DR2: P0402 on a player born with 500.
```

Three things the probe taught, recorded so the next probe does not relearn them: `deduct_diamonds` and the card settlement need the service-role claim (`set_config('request.jwt.claims', ...)`) that the API layer supplies, while the signup must run with `auth.role()` NULL because that is how the trigger door is exercised; `now()` is frozen for a transaction, so the audit trigger's two-second journal window never closes on a user the same transaction journaled (DR6 was tested on an existing horse profile, rolled back); the audit trigger fires before the born trigger on the same INSERT, so DR6 has to be back in log mode for DR2 to be the rule that answers.

After apply: `fn_ca_mint_supply('diamonds')` 1,023,527 = `SUM(profiles.diamonds)` 1,023,527; all seven rules `log`; `to_regclass` and the assertion block green; the three `probe-*@probe.smarter.poker` auth users found by the leak check date from May 2026 and are the World Hub login probe's, not this session's.

## 4. World Hub

- #1572 (merged 02:01 UTC): the ensure route outside the admin guard; the cashier E2E through the Mint.
- Pending in this round: `ensure-profile.js` re-asks the Mint for `signup:<id>` on a later login when a profile holds 0 and carries neither a `signup:` nor a `seed:` register row, so a grant the freeze refused is issued when the freeze lifts without a back-pay job; the webhook acknowledges `settlement_refused` so Stripe stops retrying a decision that will not change.

## 5. Flipping a rule, when the time comes

One migration, one line, its own changelog:

```sql
SELECT public.fn_ca_diamond_rule_flip('DR4:credit_without_reference', 'PR #<n>, <who>');
```

The function refuses before 2026-09-14 and refuses while the rule has filed anything above info in the trailing seven days. `tests/law/DiamondRulesRefuseOnlyByAFlipSomeoneRead.law.test.ts` forbids `SET mode = 'refuse'` in any migration.
