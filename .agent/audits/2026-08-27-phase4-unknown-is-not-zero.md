# Phase-4 sweep — the audit that fixed one call site and left the loaded gun

Date: 2026-08-27 · Agent: cowork-mobile · Scope: CA client + server, World Hub API, Supabase

Continuation of the phase-2/3 audits (PRs #1424, #1443, #1448). Dan: "look for
any other similar bugs, gaps, stubs, errors, regressions or wiring issues like
the ones you just caught."

## Method: hunt the CLASSES, not the instances

The three bugs already caught generalise into detectable shapes:

| class | shape                                                                | already found                  |
| ----- | -------------------------------------------------------------------- | ------------------------------ |
| A     | code reads a source that is frozen but still holds plausible numbers | `wallets` x11 sites (#1443)    |
| B     | a CHECK constraint that did not grow with the function writing it    | `ledger_reconcile_log` (#1448) |
| C     | a failed read collapsed into a definite number                       | `TablePage` `?? 0` (#1443)     |

Each was swept deliberately, and **each detector was control-tested before its
result was believed** - because in phase 3 the first version of the class-A
detector returned a clean EMPTY only because it filtered on `n_live_tup > 0`
and planner stats report a frozen table as zero rows.

## Class B — constraint-vs-writer drift: SWEPT, one instance, already fixed

170 enumerated CHECK constraints exist in `public`. Rather than eyeball them,
the writers were cross-referenced against the allowed lists:

- **DB functions**: a regex over every `pg_proc` body calling
  `log_wallet_transaction` extracted the category literal at each call site.
  5 distinct categories across 9 call sites (`bounty`, `cashout`, `prize`,
  `refund`, `tournament_buyin`) - **all permitted**.
- **Client code**: CA `src/`+`server/src/` do not INSERT into these tables at
  all; they read, and writes go through service-role RPCs. The first detector
  run reported "0 violations" here, and a **control test proved that zero was
  worthless** - narrowing the allowed set to a nonsense value still produced no
  hits, i.e. the detector was blind because there was nothing of that shape to
  see. Stated rather than glossed over.
- **World Hub API** (where the writes actually originate): re-pointed the
  detector, which then inspected **19 real literal writes** across
  `wallet_transactions`, `chip_ledger`, `spin_reserve_ledger` and
  `union_wallet_transactions` - **0 not permitted by their constraint**. That
  is a trustworthy zero: the detector demonstrably saw real data.

CONCLUSION: `ledger_reconcile_log` was the only instance, and it is fixed.

## Class C — "unknown" collapsed into a number: FIVE MORE SITES, FIXED

The 2026-08-25 audit wrote the rule ("a read that never happened is not a
balance of zero"), fixed the tournament sign-up gate, **and left the helper
that caused it**: `WalletService.getPlayerBalance`, whose entire body was

```ts
const r = await this.readPlayerBalance(userId, opts);
return r.balance ?? 0;
```

Its own docstring admitted it "collapses every failure - RPC error, RLS
denial, an unresolvable club id, a dropped connection - into the number 0".
Five call sites still used it, and phase 3 made the null case fire far more
often (readPlayerBalance no longer falls back to the frozen pool, so an
unreachable RPC now honestly answers null instead of a stale number):

| site                        | what a false zero did                                                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `useGlobalBalanceSync`      | wrote 0 into `useUserStore.totalChips` - the GLOBAL chip figure the whole app renders. One refused read blanked a funded player **everywhere at once** |
| `ChipTransferModal`         | `senderBalance` gates the send ("Insufficient balance. Available: 0"), so it **blocked an agent from sending chips they actually held**                |
| `TablePage` buy-in sheet    | presented an empty wallet on the buy-in screen                                                                                                         |
| `TablePage` add-on          | read as "cannot afford the add-on"                                                                                                                     |
| `TablePage` realtime resync | `.then(setAccountBalance)` zeroed the on-screen balance on any refused resync                                                                          |

All five now call `readPlayerBalance` and **leave the last known good value in
place** when it answers null - the rule `useWalletStore.loadBalances` already
states in this same codebase: _"a transient network failure must not replace a
good number with zeros on screen."_ The add-on site keeps a 0 default but only
because its check fails closed to the server, and it now reports the failed
read instead of swallowing it.

`getPlayerBalance` is **deleted**. A `number`-returning shorthand cannot
express "unknown", so there is no safe version to keep; the tombstone explains
why and says to decide what null means at the call site, where the consequence
is visible.

## Guards

- `tests/unit/UnknownBalanceIsNotZero.test.ts` (6 specs) pins the property
  across all sites at once - a render test would only cover the screen someone
  remembered. **Mutation-tested**: reintroducing `?? 0` in ChipTransferModal
  turns it red.
- Comments are stripped before the pins match, so prose ABOUT the old bug
  cannot satisfy a test.

## Verified

tsc clean · **7,331/7,331 tests** · deprecated-table gate green.

## Still open (unchanged, reported not fixed)

- `union_clubs`: 6,590,684 reads on a 2-row table, hot-path re-query from
  `HorseOrchestrator`. Own task.
- The 4 REAL reconciler criticals now visible (Club JAQK treasury -78,057.05,
  SHARK CLUB -32,320.73, Midway Union negative -1,202.80, seat exit #15448 =
  55 chips) - financial decisions, Dan's.
- 585 authenticated-executable SECURITY DEFINER functions - needs a batched
  per-function audit with call-site evidence.

## Class A, World Hub surface — TWO SITES STILL READ THE FROZEN POOL (reported)

Phase 3 swept CA client + server + DB. The World Hub repo was NOT in that
sweep, and it has two remaining reads of `public.wallets`:

1. `pages/api/cron/signup-probe.js:118` — a health probe asserting a `wallets`
   row exists for the probe user. Still passes today, because the signup
   trigger `on_auth_user_created_wallet -> handle_new_user_v2_create_wallet` is
   still armed and still writes that table. (This also confirms my phase-3
   retirement of `ensureWalletsExist` broke no provisioning — the trigger, not
   the client helper, is what creates these rows. Verified rather than assumed.)

2. `src/lib/poker-engine/ChipBridge.js:107` — resolves `wallet_id` from
   `wallets` in order to insert a cold-start recovery row into
   `chip_escrow_holds`, whose `wallet_id` is NOT NULL with an FK to `wallets`.
   It cannot simply be repointed at `club_members` without a schema change.

### The finding behind #2: the recovery ledger stopped recording 11 days ago

| probe                                 | value                    |
| ------------------------------------- | ------------------------ |
| `chip_escrow_holds` last row written  | **2026-08-16 00:26 UTC** |
| rows still sitting in `status='held'` | **166**                  |
| live seats holding a stack right now  | 338                      |
| hands played in the last 24h          | 217,526                  |

So the table-seat escrow ledger that exists FOR COLD-START RECOVERY has
recorded nothing for eleven days while the room played a quarter of a million
hands, and 166 holds are stranded `held` with nothing releasing them. Either
the writer is silently taking its `Escrow insert skipped: no wallet row`
branch, or the path no longer runs at all.

**NOT FIXED HERE, deliberately.** Releasing or reconciling 166 escrow holds is
money-adjacent state, the writer lives in a different repo than this PR, and
the correct fix depends on whether the recovery design is still wanted at all
(the engine has been server-authoritative since well before this stalled). It
needs its own task with Dan's call on the 166 rows. Recorded here with the
measurements so the next agent starts from evidence rather than a grep.
