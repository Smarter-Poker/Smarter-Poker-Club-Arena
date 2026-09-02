# A claim cannot destroy chips

2026-09-02. Found by reading `fn_agent_claim_commission` line by line after the
phase 7 work had landed and been published to production. Two defects, one
measurement, and one question for Dan.

## 1. The claim could debit the bank and credit nobody

The function reads the caller's `club_members` row for their role — **without
`FOR UPDATE`** — and ninety lines later credits that same row:

```sql
UPDATE club_members SET chip_balance = ... WHERE club_id = ... AND user_id = v_actor
RETURNING chip_balance INTO v_to_after;
```

and never checks that it matched. Between the two, the `clubs` row is locked
and **debited**. So if the membership row is deleted in that window — somebody
leaves the club, an owner removes them, a cleanup runs — the sequence is:

```
treasury  -= amount     committed
wallet    += amount     matched NOTHING, silently
settled_at = now()      rows stamped paid
```

The chips leave the club treasury, land nowhere, and the ledger row records a
payment that did not happen. That is precisely the failure class CLAUDE.md 11.5
was written after ("chips cannot leave the felt unnoticed") — and unlike the
seat case, there is no trigger watching this one.

Two changes, both narrowing:

- the role read takes `FOR UPDATE`, so the row cannot vanish mid-claim;
- the credit asserts it matched and **RAISES** if it did not. `RAISE` and not
  `RETURN`: PostgREST commits the transaction on a plain return, so only an
  exception takes the bank debit back with it.

Nothing else about the function moves, and the refusal ORDER the original
author was careful about — every write after the last thing that can refuse —
is asserted by the migration rather than assumed.

**Rehearsed rolled back against production:** 1,110 rows, 437.89 claimed,
treasury −437.89, wallet +437.89, **conserved 0.00**, membership locked, credit
asserted, settle still after the debit.

## 2. The claim receipt had no idempotency index

Every other money path on `chip_transactions` carries a partial `UNIQUE` index
on `(club_id, metadata->>'op_id')`:

| Index                         | Covers                                                             |
| ----------------------------- | ------------------------------------------------------------------ |
| `..._agent_wallet_op_id_uidx` | `agent_wallet_send`, `agent_wallet_claim_back`, four cashout types |
| `..._club_bank_op_id_uidx`    | `club_bank_send`, `club_bank_reversal`                             |
| `..._staff_ops_op_id_uidx`    | `admin_removal`, `mint`, `cashout_expired_refund`                  |
| `..._wallet_ops_op_id_uidx`   | `club_bank_claim`, `promo_wallet_send`                             |
| _(nothing)_                   | **`commission_claim`**                                             |

The claim's replay guard is a `SELECT` on that receipt before the `INSERT`.
Without a unique index that is **check-then-act**: two requests carrying the
same `op_id` can both find no prior row and both proceed. Row-lock ordering
makes an identical double-payment unlikely rather than impossible, and
"unlikely" is not the guarantee the other five paths give.

**It cost nothing to add now, and that is the point of doing it now:**
production holds **zero** `commission_claim` rows, so there was no backfill, no
duplicate to resolve, no chance of the build failing on existing data. After
the first real claim it becomes a migration with a data problem attached.

Built `CONCURRENTLY`, in its own migration, because a plain `CREATE INDEX` takes
`ACCESS EXCLUSIVE` on the table every money path writes to, and `CONCURRENTLY`
cannot run inside a transaction.

## 3. 643.43 chips are owed to payees who cannot claim them

Measured on production: **79 (club, user) pairs** hold unsettled commission and
have **no `club_members` row at all** in the club it is booked to, so
`fn_agent_claim_commission` refuses them at the membership check — correctly,
since it pays into `club_members.chip_balance`, which they do not have.

**All 79 are horses.** Under CLAUDE.md 10.5 a horse is paid everything a human
is paid, so this is money owed and unreachable, not money that does not exist.
It is still growing: 2 of 17,411 rows in six hours, roughly 11 chips a day,
across 2 clubs.

### The cause

The second lookup in `credit_agent_commission_from_rake`:

```sql
-- The caller may itself be an agent generating rake.
IF v_agent_id IS NULL THEN
  SELECT ... FROM agents WHERE user_id = p_agent_user_id AND status = 'active'
   ORDER BY (club_id = v_book_club) DESC LIMIT 1;
END IF;
```

The **first** lookup is correctly scoped to the booking club — it joins
`club_members` on `cm.club_id = v_book_club`. This fallback is scoped to **no
club at all**: it finds the user's `agents` row in _any_ club, and the `INSERT`
then books the commission to `v_book_club`, a club that row has nothing to do
with and that the payee may not be a member of.

### What this change does about it: nothing, on purpose

Narrowing that lookup decides **who earns money**, and that is Dan's call, not
an agent's. CLAUDE.md 10.5 exists because I once wrote an earnings exclusion on
my own assumption and then reported the resulting zero as correct behaviour.

**The two ways forward, both costed, for Dan:**

- **A — scope the fallback to `v_book_club`.** Nothing accrues where it cannot
  be claimed; that rake stays with the club, as it already does for any
  non-agent. Simplest, and stops the growth. The 643.43 already accrued still
  needs a home.
- **B — book to the club the `agents` row actually lives in**, so the payee can
  claim it where they are a member. Pays everyone what they earned, but changes
  union-law money routing, which has wider consequences.

What this change _does_ do is make it **visible**, which the horses law
requires on its own terms — a horse is "never silently filtered out of a report,
a total, or a ledger". `fn_club_unclaimable_commission(p_club_id)` reports it
per club, or estate-wide with no argument, counting horses and humans
separately and filtering neither.

## One thing my own assertion caught

The report function's first apply attempt **failed on its own check**:
`authenticated` still had `EXECUTE`. Supabase's default privileges grant it on
every new function in `public` to `anon` **and** `authenticated`, and
`REVOKE ... FROM PUBLIC` does not take those away — they are direct grants to
named roles, not the `PUBLIC` pseudo-role. Nothing was applied; the explicit
`REVOKE ... FROM authenticated` went in and the migration then applied clean.
That is why the grant check is an assertion inside the migration and not a
comment beside it.

## Law

`tests/a-claim-cannot-destroy-chips.law.test.ts`, registered in `docs/LAWS.md`.
14 pins across seven groups: the membership row is locked; a credit that lands
nowhere aborts the claim by raising rather than returning; the refusal order is
asserted; the claim is patched and never re-emitted, using
`pg_get_function_arguments` rather than the identity form; the receipt has its
partial unique index, built `CONCURRENTLY` and alone; and unreachable money is
reported with horses counted, service-role only, with `authenticated` revoked
explicitly.
