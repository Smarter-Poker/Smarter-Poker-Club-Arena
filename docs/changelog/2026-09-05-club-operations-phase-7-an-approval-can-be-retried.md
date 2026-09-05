# Club Operations Phase 7: an approval can be retried, and a freeze means something

Phase 7 of 8 of Dan's Club Operations upgrade
(`docs/club-operations/OPERATIONS-UPGRADE-PLAN.md`, section 9). The surfaces
are the two cashiers, the chip-request queue and the settlement page.

The write paths themselves are the best-defended code in this workspace and
this work does not touch them: `fn_agent_wallet_send` still takes its mandatory
retry key, takes its advisory lock, replays on the op id and refuses a key that
belongs to a different intent; `fn_cashier_batch_transfer` still validates the
whole envelope before the first item moves. What was wrong is what wrapped
around them.

Everything below was proved against production inside a transaction that was
rolled back (CLAUDE.md 11.5) before anything was changed.

## Approving a chip request could not be retried

`fn_respond_chip_request` locks the request `FOR UPDATE` and refuses anything
not `pending`, so a double tap could never send twice - that part was sound.
But for the money move it called

```sql
fn_agent_wallet_send(..., gen_random_uuid())
```

a **fresh retry key on every attempt**. So in the one case a retry key exists
for - a response lost on the wire - the chips had moved, the request was
approved, and the operator's retry was told **"request already approved"**,
which the client turns into a red toast. Money moved; the person who moved it
was told it had not. That is the worst shape a money screen can take.

`chip_requests` has carried an `op_id` column, with a unique index on
`(club_id, requester_id, op_id)`, since requests themselves were made
idempotent. The retry key was designed into this table and the approval path
simply never used one.

Now the send's key is derived from the request id, so it is the same key on
every attempt and `fn_agent_wallet_send` replays instead of re-sending. A retry
that arrives after the request is already approved no longer reports a failure:
it looks for the `chip_transaction` written under that key and returns the
original receipt with `replayed: true`.

**It only claims a replay when it can see the transaction.** Approvals made
before this migration used a random key, so nothing is found under the derived
one and those keep the old honest refusal - re-sending them is the one outcome
that would actually move money twice.

Proved, then rolled back:

```
D. approve #1        {"status":"approved","success":true,"replayed":false,
                      "your_balance":130987.66,"their_balance":9728.54}
E. approve #2        {"status":"approved","success":true,"replayed":true,
   (the retry)        "transaction_id":"37fc6356-...","amount":12.34}
F. sends under the derived key: 1
```

## A declared settlement freeze froze nothing

`clubs.settlement_locked` is what an operator sets to stop chips moving while
the books are squared. Measured: the only two functions in the database that
read it are `expire_settlement_locks` (the sweep that clears it) and
`ca_club_operations_overview` (which displays it). **No money function read it
at all** - not the sends, not the claim-backs, not the batch transfer.
`checkSettlementLock` exists in the client, fails open by design, and is called
from the classic cashier only; the Trade cashier never checked it.

It is enforced now the way the platform already enforces its maintenance freeze
(CLAUDE.md 13): a `BEFORE INSERT` trigger on `chip_transactions`, not a check
bolted into each of the four money functions - so a path nobody remembered
cannot slip past it, and the 191-line defended bodies stay untouched.

**What it freezes, and what it deliberately does not.** A settlement freeze is
about operator movement - sends, claim-backs, commission claims, promo pushes,
admin removals. It must never stop a game, and `fn_atomic_buyin` writes a
`mint` row, so freezing mints would refuse buy-ins mid-session. Every gameplay
type is excluded by name, `service_role` keeps its escape so the settlement
runner can still move the chips the freeze exists to protect, and the test pins
both halves.

Proved, then rolled back: with a freeze declared, approving answers _"this club
is squaring its books - approvals resume when the settlement freeze lifts"_;
with it lifted, the same approval succeeds. Nothing is locked today (0 of 4
clubs), so this changes no behaviour on the platform as it stands - it makes
the switch real for the first time.

The trigger's own refusal cannot be exercised from psql: `session_user` there
is `postgres`, which the guard treats as an internal caller by design. Its
shape is asserted by the migration and its user-visible effect is the refusal
above - the same limitation recorded in phase 5.

## The settlement page wrote to whatever the URL said

`.eq('id', clubId)` with the **route param** - a club code on every
`/clubs/<slug>/settlement` URL - against a uuid column, on both the read and
the write. Two consequences, both live:

- the read answered 22P02 and the `catch` swallowed it as "non-critical", so a
  club with auto-settlement **ON rendered OFF**;
- the write had no `.select()`, so when RLS refused it - `clubs` is UPDATE-able
  only by `owner_id = auth.uid()`, which a co-owner or admin is not - PostgREST
  returned 204 with no error and the page toasted "Auto-settlement enabled" for
  a switch that had not moved.

The resolved uuid was already in hand a few lines above. It is used for both
now, the write asks for the row it changed and says who may change it, and a
switch drawn from a failed read reads **"Auto: Unknown"** rather than a
confident OFF.

## The two cashiers disagreed about what a chip is

The classic cashier refused any fraction - "Chips must be a whole number" -
and its comment and its test both explained why: "the per-club ledger column
(`club_members.chip_balance`) is an integer, so a fractional amount is rounded
on write". **That premise is false**, and measuring it was a one-line query:
the column is `numeric(20,2)`. It stores 12.34 exactly and nothing rounds.
Meanwhile the Trade cashier on the same platform accepts two decimals and says
so, so the same operator could send 0.50 from one screen and be refused it on
the other.

The classic page now accepts two decimal places and refuses a third, which is
what the column can hold. The exponent rule ("1e9" - a billion chips from four
keystrokes) and the ceiling stay exactly as they were, because both were real.

## Verified

- Migration `20260905040100`, one transaction, applied and recorded.
- Every behaviour above proved live inside a rolled-back transaction.
- 15 new pins in `tests/unit/anApprovalCanBeRetried.test.ts`; the amount pins
  in `CashierAmountValidation.test.ts` moved to the new rule with the measured
  reason, in the same commit.
- The discarded-error ratchet caught the improvement it should:
  `SettlementPage.tsx` went from 2 discarded reads to 0 and moved to
  AUDITED_ZERO.
- Full suite green (13,105 tests), all local gates OK.

## Still open in this phase

The rest of section 9 - the settlement period that is not this club's, the
receipt that hardcodes `paid`, "Execute Settlement" calling a documented no-op,
`disputed` missing from the page's own type, the classic cashier reporting
through `setMessage` instead of the Toast layer, and
`fn_club_cashier_members_page_v3` re-running the recursive downline walk on
every page - plus the two items carried from phase 6 (`fn_ca_rake_by_agent` at
29.7s, and the bomb pot report's role-dependent slowness).
