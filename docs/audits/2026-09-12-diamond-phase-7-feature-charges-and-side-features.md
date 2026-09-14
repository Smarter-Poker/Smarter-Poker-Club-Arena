# Diamond Phase 7: Feature Charges, Side Features And Insurance Liabilities

Status: Complete For Phase 7 Checklist Lines Five And Six. Public Funded Diamond Games Remain Closed And `cash_games_enabled` Remains False.

This answers two Phase 7 checklist lines and reports one defect found on the way that this phase did not fix.

- "Keep feature diamond charges separate from game stakes, with no double charge."
- "Audit insurance and side-feature liabilities before enabling any such product."

## Method

Three sources, none of them a migration file. The repo's `supabase/migrations` are deliberately stale, so every SQL claim below was read from the live schema of `kuklfnapbkmacvwxktbh` with read-only queries against `pg_proc`, `pg_indexes` and `feature_pricing` on September 12, 2026. Client and engine claims were read from `origin/main` at `8f42fa12`. The custody door claims were exercised in the isolated Phase 6 Postgres fixture, which never connects to production.

## A Feature Charge Cannot Reach A Stake

Every Diamond feature charge debits `profiles.diamonds`, which is the wallet. Every Diamond stake lives in `poker_diamond_custody`, which the wallet was already debited into at the door. The two cannot be the same Diamond, and neither writer can see the other's storage. Read from the live function bodies:

| Function                    | `poker_diamond_custody` | `poker_diamond_movements` | `poker_diamond_lot_reservations` | `table_seats` | `club_members` |
| --------------------------- | ----------------------- | ------------------------- | -------------------------------- | ------------- | -------------- |
| `deduct_diamonds`           | no                      | no                        | no                               | no            | no             |
| `fn_purchase_feature`       | no                      | no                        | no                               | no            | no             |
| `fn_purchase_time_banks_v2` | no                      | no                        | no                               | no            | no             |
| `fn_consume_rabbit_hunt_v2` | no                      | no                        | no                               | no            | no             |
| `fn_use_throwable_v2`       | no                      | no                        | no                               | no            | no             |
| `fn_time_bank_allowance`    | no                      | no                        | no                               | no            | no             |

And the reverse, which matters just as much, because a stake writer that quietly granted a feature would be the same bug wearing the other hat:

| Function                            | `feature_purchases` | `feature_pricing` | `deduct_diamonds` | time banks | throwables | rabbit hunt |
| ----------------------------------- | ------------------- | ----------------- | ----------------- | ---------- | ---------- | ----------- |
| `fn_poker_diamond_reserve`          | no                  | no                | no                | no         | no         | no          |
| `fn_poker_diamond_release`          | no                  | no                | no                | no         | no         | no          |
| `fn_poker_diamond_top_up`           | no                  | no                | no                | no         | no         | no          |
| `fn_poker_diamond_buyin`            | no                  | no                | no                | no         | no         | no          |
| `fn_poker_diamond_cashout`          | no                  | no                | no                | no         | no         | no          |
| `fn_poker_diamond_settle_cash_hand` | no                  | no                | no                | no         | no         | no          |

The settlement path agrees from the third direction: for a Diamond hand the engine sends no rake, no BBJ, no insurance record, no promo playthrough, no daily mission event and no pending add-on, and `fn_ca_commit_hand_settlement` refuses the hand outright if any of them is non-empty.

## No Double Charge, With One Exception That Is Not Diamond's

`diamond_transactions` carries a unique index on `(user_id, reference_id)`, so `deduct_diamonds` called twice under one reference id debits once. Every in-game feature door takes a caller-held request id and stores a receipt: `fn_consume_rabbit_hunt_v2(p_user_id, p_request_id)`, `fn_purchase_time_banks_v2(p_quantity, p_request_id)`, `fn_use_throwable_v2(p_throwable_id, p_request_id)`, and `fn_purchase_feature_v2(p_user_id, p_feature, p_request_id)` which caches into `digital_purchase_receipts`. A lost response followed by a retry under the same id returns the first receipt and charges nothing.

The exception is the a-la-carte purchase door, and it is worth stating exactly because it reads as safe.

`fn_purchase_feature(p_user_id, p_feature, p_cost)` is a shim. Its whole body is an auth check and then `fn_purchase_feature_v2(p_user_id, p_feature, gen_random_uuid())`. It mints a NEW request id on every call, so the idempotency the v2 door was built for cannot apply through it. For the 65 `permanent` and `per_session` features that is harmless: v2 answers `already_owned` and charges nothing. For the four `per_use` features in `feature_pricing` today, `auto_time_bank`, `rabbit_hunt`, `throwable` and `time_bank_seconds`, there is no such refusal, and the a-la-carte grid on the VIP page renders a Buy button for each of them. A player whose response is lost and who taps Buy again is charged a second time and receives a second unit.

No client anywhere calls `fn_purchase_feature_v2`. The correct door exists, is `SECURITY DEFINER`, is granted to `authenticated`, and is wired to nothing.

This audit does NOT fix it. It is not a Diamond path, it is not reached from a Diamond table, and the fix touches `VIPService`, `ThemeSettingsModal` and eight test files in the customization and VIP commerce estate, which is another programme's surface. The fix itself is small and already has a precedent in this repo: call `fn_purchase_feature_v2` with a request id held across retries and rotated when the server answers, exactly as the cashier's `opIdRef` does. It is recorded here and reported to Dan for a decision on when it lands.

## Side Features At A Diamond Table

No asset gate hides any of them. Every `arenaAsset === 'chips'` condition in `src/pages/TablePage.tsx` belongs to the cashier and top-up family; skins, card decks, time banks, rabbit hunt, chat, voice and throwables carry no asset condition at all, and the components that do mention the asset use it only to choose a unit word or a decimal place. Each of their charges lands on `profiles.diamonds` through the table above.

What that establishes is that they are reachable and that their money cannot touch a stake. It does not establish that each has been exercised at a live Diamond table, which cannot happen while the arena is closed, so Phase 7 checklist line four is NOT claimed by this audit.

## Insurance And Side-Feature Liabilities

Insurance stays unavailable, and so does the Bad Beat Jackpot. Both are refused at every layer that could admit them:

- `assertDiamondCashTable` refuses a table with `insurance_enabled`, a non-zero `rake_percent` or a non-zero `bbj_percent`, at load and again on every settings refresh.
- `fn_poker_diamond_buyin` refuses the same table at admission.
- `HandController` refuses to construct a Diamond hand with insurance, rake or BBJ enabled.
- `assertDiamondAcceptedHand` requires `insuranceCount`, `rake`, `bbj` and `inflow` all zero.
- `fn_poker_diamond_settle_cash_hand` refuses a non-zero `p_rake`, `p_bbj` or `p_inflow`.
- `fn_ca_commit_hand_settlement` refuses a Diamond accepted hand carrying an insurance record, a rake row, a BBJ contribution or bomb award units.

The reason they must stay closed is not caution, it is that the counterparty does not exist. Insurance is banked by `union_wallets.insurance_wallet` and `club_wallets.insurance_balance`; BBJ pools are club and union chip pools. Both are chip accounts, and the programme assigns Diamond rake, fee and BBJ destinations to Phase 9. Until a Diamond house counterparty exists there is nothing for a Diamond liability to be owed by.

## What This Audit Claims

- Phase 7 checklist line five is met: feature charges and game stakes are separate storage with no writer in common, in both directions, and every in-game feature door is idempotent under a caller-held request id.
- Phase 7 checklist line six is met: insurance and the side-feature liabilities were audited before anything was enabled, and the answer is that they stay unavailable in Phase 7.
- Nothing here claims lines one, two, three, four or seven, and nothing here opens a funded Diamond game.
