# Audit — every remaining wallet credit on the platform, read line by line

**Date:** 2026-08-22 · **Repo:** Smarter-Poker-Club-Arena · **Author:** Claude (Cowork session)
**Follows:** `2026-08-22-null-multiplier-spins-and-the-double-ledger.md` (PR #248),
`2026-08-22-the-deploy-gate-was-lying.md` (PR #254)

---

## 0. WHY

PR #248 fixed the credit-then-log double-entry in the **tournament** prize
paths. That fix was site-by-site, which is only half a fix: the shape it
corrected is available to every caller of `credit_player_wallet`, and there
were four more of them. This pass read all of them.

Four more defects. Two are live, one is a loaded gun, one is a silent gap. Plus
one thing that is not a bug and needs a decision instead.

---

## 1. THE TWO TABLE CASH-OUT PATHS CREDITED DIFFERENT WALLETS — live

`markSeatAsLeft` and `atomicCashout` in `server/src/services/supabase/seats.ts`
cash the same seat out. They deliberately share one idempotency key —
`cashoutKey(seat)` — so whichever runs second is a no-op. The comment on each
says so.

They did not share anything else.

|                           | `markSeatAsLeft`                      | `atomicCashout` (before)        |
| ------------------------- | ------------------------------------- | ------------------------------- |
| RPC                       | `atomic_credit_wallet_and_log`        | `credit_player_wallet`          |
| club resolved from        | the **seat's** club, then home club   | home club **only**              |
| `wallet_transactions` row | written inside the RPC, under the key | hand-written **after**, ungated |
| `chip_transactions` row   | yes                                   | **no**                          |

Two consequences:

1. **The double ledger row.** The shared key makes the credit a no-op for the
   second path — and `atomicCashout` then wrote a `cashout` row anyway, for
   chips it did not move. Identical to the tournament defect.

2. **The money could land in a different club's books.** For a player seated at
   a club that is not their home club, `fn_player_home_club` and the seat's
   `club_id` are different wallets. Which one received the stack depended on
   which path happened to run the cash-out — and the `chip_transactions` row
   that records it against the club existed only if it was the sibling.

`atomicCashout` now calls the same RPC with the same arguments. One credit, one
ledger row, one club, one transaction. The extra `wallets` read for
`balance_after` is gone too; the RPC computes it.

**Note for whoever comes next:** `fn_credit_and_log`,
`atomic_credit_wallet_and_log` and `fn_credit_player_wallet_once` are **not**
interchangeable and must not be "consolidated". Only
`atomic_credit_wallet_and_log` knows about seat provenance and mirrors to
`chip_transactions`; only the `credit_player_wallet` family parses a `tourney:`
key to resolve the club through `tournament_players`. Picking the wrong one
credits the wrong club. That is exactly what §1 was.

---

## 2. `refillHorseWallet` HAD NO KEY AND LOGGED UNCONDITIONALLY — live

`server/src/services/supabase/wallets.ts`. Read-then-write: `SELECT balance`,
compute `topUp = minBalance - balance`, credit it. **No idempotency key.** The
lifecycle sweep and `AutoRebuyService` can both be inside it at once, both read
the same balance, and both credit the difference — the horse ends up at twice
the floor.

Now keyed on the balance that was actually observed
(`horse-refill:{horse}:{wallet}:{balance}:{floor}`), so a duplicate of _this_
decision is a database-side no-op while a genuine later refill — a different
observed balance — still goes through.

The ledger insert underneath it was unconditional, so keying alone would have
converted a double credit into a double row. It now goes through
`fn_credit_player_wallet_once`, which reports whether it was the one that
credited, and the insert is gated on that. This is the one caller that needs
the boolean rather than `fn_credit_and_log`: it computes `balance_after`
itself from the balance it already read, and that field would otherwise be
lost.

---

## 3. TWO DEAD METHODS ON A MONEY PATH — removed

`HorseLifecycleManager.processWinnings` and `.processElimination` had **no
callers anywhere in the repo**. `processWinnings` was a loaded gun for whoever
wired it up next:

- `credit_player_wallet` with **no idempotency key** — any retry above it pays
  the prize again;
- it took `tournamentId` **and never used it**, so its ledger rows carried no
  `related_entity_id` and could not be tied back to the event —
  `fn_tournament_payout_reconcile` matches on exactly that column, so every one
  of those prizes would have been invisible to reconciliation;
- category `tournament_winnings`, a value that appears **nowhere else** on the
  platform, so every prize report would have missed it too.

Deleted, with a comment in its place saying where tournament prizes are
actually paid.

---

## 4. THE STARTUP CASH-OUT MOVED CHIPS AND WROTE NOTHING — silent gap

`GameServer.cleanupStaleData` cashes every seated player out on boot. It called
`credit_player_wallet` and logged **nothing at all** — no `wallet_transactions`
row, no `chip_transactions` row. Chips appeared in balances with no record
behind them, on every restart.

Now goes through `atomic_credit_wallet_and_log` with `p_category: 'cashout'`,
same as every other cash-out on the platform. Same idempotency key, so nothing
about the dedupe changes; club resolution is unchanged for a null `table_id`.

---

## 5. NOT A BUG — a reversal that needs Dan, and was left alone

`supabase/migrations/20260821_library_only_avatars.sql` declares
`fn_is_photo_avatar` and `fn_pick_library_avatar`. Neither exists in
production, which is the same signature the never-applied
`20260821_challenge_rerolls.sql` had. It is not the same story.

That migration **ran**, on 2026-08-21 19:49:37Z. It backed up and moved 17
human profiles onto library art and its own assertion confirmed zero remaining
before it committed. Production today:

```
avatar_photo_migration_backup      17 rows, all 19:49:37Z
profiles matching old_avatar_url   17   <- every single one back on its photo
profiles matching new_avatar_url    0
fn_is_photo_avatar                 absent
fn_pick_library_avatar             absent
```

That is the file's own ROLLBACK block, executed, with the helpers dropped
afterwards. Deliberate — nothing in the repo does it automatically and no other
migration references those objects.

So Dan's _"they can now only use avatars"_ is true going forward through the UI
and service guards, and **not true for the 17 accounts that already had a
photo.**

**Deliberately not re-applied.** Somebody reversed a user-visible policy on
purpose; re-running it would be re-litigating their decision without knowing
it. The migration file now carries a STATUS header recording exactly this so
nobody re-runs it blindly, and if it is re-applied the real question is what
will stop it being reversed a second time — nothing did the first time.

---

## 6. WHAT IS NOW GUARANTEED, NOT JUST FIXED

`tests/config/walletCreditIntegrity.test.ts` walks **every `.ts` file under
`server/src`** and enforces two rules platform-wide rather than at the sites
that happened to break:

1. **Every credit carries an idempotency key.** One test per call site,
   discovered by walking the tree — a new site is covered the day it is
   written, with no test to remember to add. Currently 12 sites, all keyed.
2. **No site credits and then logs as a separate ungated step.** A
   `log_wallet_transaction` call or a hand-written `wallet_transactions`
   insert within reach of a credit fails, unless it is gated on
   `fn_credit_player_wallet_once` reporting that it was the one that credited.

Plus three specific pins: the two cash-out paths must call the same RPC and
derive their key from the same helper; the dead horse-winnings path stays dead;
the boot cash-out keeps its ledger row.

**Verified against the unfixed tree: 10 of the 25 assertions fail.** A test
that has never been seen to fail is not a regression test.

---

## 6b. A GATE THAT BLOCKED A COMMENT

Adding the STATUS header in §5 turned the **TypeScript Check** job red, and the
gate was right by its own rules. `check-migrations-applied.mjs` diffs with
`--diff-filter=AM`, so a MODIFIED migration is in scope — correct, because
appending a `CREATE FUNCTION` to an old file strands it exactly like a new one.
But it judged the file's **whole contents**, so touching a historical migration
at all re-asserted every object it had ever declared.

That made a class of file permanently untouchable: a migration that was applied
and then legitimately rolled back, its helpers dropped on purpose, could no
longer receive so much as a comment. And a gate that blocks a comment is a gate
somebody starts bypassing.

It now checks the **difference**. Objects already declared at the base commit
are that commit's business; only what this branch newly declares is judged.
Verified both ways: the comment passes, and appending a
`CREATE OR REPLACE FUNCTION` for a non-existent object to that same historical
file still exits 1 with the object named.

---

## 7. WHAT WAS CHECKED AND WAS FINE

- **Phantom references:** 0 tables, 0 rpcs, 0 columns. Nothing in the codebase
  calls something that does not exist.
- **Unfinished migrations:** no file in `supabase/migrations/` still carries an
  unfinished marker. `20260821_challenge_rerolls.sql` — the one that did — was
  deleted in #248.
- **Migration-declared functions absent from the live schema:** 53, all of them
  historical. Every one is a legacy object dropped by later work
  (`register_for_tournament`, `distribute_tournament_prizes`,
  `add_to_player_wallet`, …), and the phantom-RPC gate confirms **no live code
  calls any of them**. Expected drift, not a gap — but worth knowing the number
  is 53 and not 0 before reading anything into a single missing function.
