# 2026-09-08 - Transfers are off, and a gift is one transaction

Rulings 4 and 12 of `docs/DIAMOND-RULINGS.md`, built. Migration `20260908031918`, applied and registered; World Hub side in the same round. Everything below was read from the live bodies or from a probe that was rolled back.

## 1. Player-to-player transfers are off (ruling 4)

`send_wallet_diamond_transfer` refuses with `p2p_transfers_disabled` and is revoked from `authenticated`. The function is kept rather than dropped so a caller still in flight gets an answer it can read instead of a 42883. `POST /api/store/diamond-transfer` answers 410 with the same words, and the wallet's "Send Diamonds To A Friend" hitbox now says so instead of opening a form that would fail at the end.

`transfer_diamonds_credit` and `transfer_diamonds_deduct` are dropped. They were the legacy pair: the deduct wrote a journal row with no reference and no class, the credit wrote none at all, and nothing in either repo called them.

## 2. A gift is one transaction, and five things were wrong with it

`send_stream_gift` already existed and was already atomic in shape. Reading it line by line against the standard found five defects, each fixed here:

| What was wrong                                                                                                         | What it cost                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The idempotency guard looked for `reference_id = <ref>` while the function writes `<ref>:sender` and `<ref>:recipient` | A replay of the same reference was **never** caught: the same gift could be sent twice                                                                                                                                                                           |
| Both journal legs left `counterparty` and `issuance_class` NULL                                                        | The classifier filled them and filed `DR12` against this writer on every gift                                                                                                                                                                                    |
| Two profile rows locked by one `ORDER BY ... FOR UPDATE`                                                               | `ORDER BY` does not order the locks; two players gifting each other at once could deadlock                                                                                                                                                                       |
| A gift could move **purchased** diamonds                                                                               | The purchase lots - the refund and chargeback sub-ledger of ruling 1 - would point at diamonds that had left. Ruling 4's "promotional balance first" is now enforced by `fn_ca_giftable_balance`: a player may gift only what is not an unconsumed purchased lot |
| The function is granted to `authenticated` but was **missing from `fn_guard_profile_privileged_columns`**              | A player calling it got 42501 "profiles.diamonds is server-managed". Nobody had noticed, because the World Hub route never called the RPC at all                                                                                                                 |

## 3. The World Hub route stops compensating

`POST /api/live/gift` used to debit the sender, credit the broadcaster, and hold a `refundSender()` closure to undo the debit if the credit failed - three writes and a compensating one, the exact shape CLAUDE.md 10.12 forbids, and the shape that leaves a player short if the process dies in the middle. It now makes one call to `send_stream_gift`, **as the player** (their bearer token, not service_role), so `auth.uid()` is the sender and the anti-farming ladder sees the real account. The gift row comes back from the transaction that created it; the broadcast and the IP-cluster record are unchanged. The catch block has nothing left to undo.

## 4. The ladder applies to everyone (rulings 4 and 12)

- **The hard-coded account is gone.** `47965354-…` returned `allowed: true` before any check ran. An exempt account is a row in a table Dan owns, with a reason.
- **Both waivers are gone.** Tier 4 lifted every cap seven days after the cheapest purchase a farmer can make; tier 5 lifted them for any account that had simply existed 120 days. The pair (5,000/24h), user (50,000/24h), burst (2,000/60s) and fresh-paid (500/24h) caps now apply to every sender.
- **Two policies were live under one name.** A second, two-argument `fn_check_anti_farming_gift_cap` carried a different rule set - a 30-day block, a flat 500/day, a blanket VIP exemption - and was granted to `authenticated`. Nothing called it. Dropped.
- **No lift date is promised any more.** `limits_lift_at` used to name a day on which nothing will now happen; it returns null, and the message says the limits are per recipient, per day and per minute for every account (CLAUDE.md 10.86: a field that answers when it does not know is worse than an empty one).

The ladder body was rewritten whole rather than patched: its live text carries trailing whitespace on every line, so a hand-typed marker never matches, and a patch that cannot match is a patch that silently does nothing. The migration's body is the live one with three blocks removed and nothing else changed.

## 5. The probe (one transaction, rolled back by its final RAISE)

```
PROBE OK (rolled back):
1 p2p: refused, balance untouched, revoked from authenticated.
2 gift: 100 moved 400 -> 600, both legs transferred, register unmoved.
3 replay: refused as duplicate, balance untouched.
4 purchased: giftable 0 of a 400 balance that is all lots, gift refused.
5 ladder: a 400-day-old account that has purchased is still capped (pair_24h_cap),
  and no lift date is promised.
```

Step 2 runs as the **player**, not as service_role, so the privileged-column guard is part of what is being tested - which is how the missing allowlist entry was found.

## 6. Verified after apply

`transfer_diamonds_*`: 0 functions. `fn_check_anti_farming_gift_cap`: 1 overload. `send_wallet_diamond_transfer` acl: postgres and service_role only. `fn_ca_mint_supply('diamonds')` 1,023,527 = `SUM(profiles.diamonds)` 1,023,527.

## 7. Left for a follow-up

The transfer panel inside `DiamondWalletModal.jsx` is unreachable (its trigger no longer sets `showTransfer`) but the JSX and the friends-fetch are still in the file. They come out with the rest of the friends-transfer code rather than in a money change.
