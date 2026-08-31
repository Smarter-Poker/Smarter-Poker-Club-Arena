# Phase 2 of 7: a credit line is spendable, and staff hold agent wallets

**2026-08-31.** Migration `20260901000002`, applied to production.
Phase 1 was `20260901000001` (the invoice biller). Phase 0 was PR #2132.

## What was wrong

`agents.credit_used` was `0.00` for every agent on the platform and always had
been. 111 active agents held **7,674,633 chips** of credit line that could not
be drawn, because the only function that spends an agent wallet,
`fn_agent_wallet_send_core_20260830`, refused outright when the wallet was short
and had never contained the words `credit_used` or `is_prepaid`.

Five defects, all live before this migration:

1. **The line was not drawable.** As above.
2. **A claim back returned the chips and left the debt.** An agent who sent on
   credit and undid it inside the ten minute window would have held both.
3. **The promotion never assigned funding.** `fn_club_set_member_role` hardcoded
   `credit_limit, 0` and never touched `is_prepaid`, so every promoted agent
   landed on the one combination that can send nothing: not prepaid, no line.
   Three agents were in that state.
4. **Staff could not hold an agent wallet.** `fn_create_agent` refused an owner
   or a co-owner by name. Dan, verbatim: _"OWNERS AND CO OWNERS CAN AND SHOULD
   HAVE AGENT WALLETS, THAT WAS A MISTAKE."_
5. **A trigger collision nobody had found**, and the reason fixing (4) alone
   would not have worked. Two triggers on `public.agents` contradict each other:
   `trg_agents_commission_bounds` raises when a rate falls outside the union
   policy band, and fires **before** `trg_agents_staff_earn_no_rakeback` sets a
   staff rate to zero. Midway Union sets `min_agent_commission = 0.20` across 2
   clubs, so in those clubs **promoting anyone who held an agents row to
   co_owner or admin failed outright**, and a staff wallet could not be minted
   at all. Proved against production inside a rolled-back transaction:

   ```
   P1 update-existing-to-zero:   REFUSED [agent commission 0.0000 is outside
                                 the union policy band (0.20 .. 0.70)]
   P2 mint-staff-wallet-at-zero: REFUSED [same]
   ```

## Dan's rulings this phase

| Question                                                      | Ruling                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What does `credit_limit` cap?                                 | _"NO, IF THEY GO BELOW THE CREDIT LIMIT, THEY MUST 'SQUARE UP' OR PRE PAY FOR CHIPS FOR THE REST OF THE WEEK."_ It caps the debt outstanding. `credit_invoices` periods are exactly 7 days, so "the rest of the week" is the billing period already in place, and phase 1 made paying an invoice pay `credit_used` down, so squaring up genuinely restores the line. |
| Does a re-promoted agent inherit their old deal? (B-01)       | **Force a fresh choice.** Commission, rakeback, prepaid-or-credit and the amount are all chosen again. Re-grading an agent who is already an agent still carries their live terms forward.                                                                                                                                                                           |
| Do owners earn no rakeback, like co-owners and admins? (B-02) | **Owners keep earning.** The staff bar stays on `co_owner` and `admin` only.                                                                                                                                                                                                                                                                                         |

## What changed

**Database** (`20260901000002`, seven functions, no schema change):

- `fn_enforce_agent_commission_bounds` stands aside for a rate of zero on a
  member the club already records as staff. Every other row is still bound.
- `fn_ensure_agent_row` mints a staff wallet at zero, prepaid, with no line,
  instead of inventing the union minimum.
- `fn_club_set_member_role` gains `p_is_prepaid` and `p_credit_limit`, refuses an
  agent promotion with no funding (`needs_funding`), refuses prepaid-with-a-line
  and credit-with-no-line, caps the limit at the upline's, and does not inherit a
  stale deal on re-promotion. **The 6-argument overload is dropped** - two
  signatures would make the PostgREST call ambiguous.
- `fn_create_agent` mints a staff agent wallet **without touching their club
  role**, and zeroes the rate for a co-owner or an admin only.
- `fn_admin_update_agent` stops barring an owner from earning, and forwards the
  funding to the one write path.
- `fn_agent_wallet_send_core_20260830` draws the shortfall against the line and
  records `credit_drawn`, `credit_used_after` and `credit_limit` in the ledger
  metadata and the return value, replay branches included. The rule is **ported**
  from `transfer_chips_agent_to_player` (zero callers, wrong account), not
  invented.
- `fn_agent_wallet_claim_back_phase2_core_20260831` repays `credit_used` in
  proportion to the fraction claimed, clears the remainder exactly on the final
  claim, and never repays a debt already settled another way.

**Client:** `MemberManagementPage` `RoleSection` collects Prepaid or Credit Line
and the amount beside the rate fields, nothing pre-filled, 44px targets, and
clears itself when another role is picked. `MembershipService.updateRole`
forwards both.

## How it was verified

The entire migration was run against production **inside a transaction that was
rolled back**, with the behavioural probes in the same transaction
(`CLAUDE.md` section 11.5). No production chip moved; estate `credit_used` was
`0.00` before and after.

```
02 promote agent, no funding      success=false needs_funding=true
03 prepaid with a limit           success=false a prepaid agent carries no credit line
04 credit with a zero limit       success=false a credit line must be greater than 0
05 promote on credit 25000        success=true  prepaid=f limit=25000 used=0
06b re-promote, nothing supplied  success=false needs_rates=true
06c re-promote, rates only        success=false needs_funding=true
07 prepaid agent short            success=false Your Agent Wallet Only Holds 10.00 Chips
08 credit agent sends 100 on 10   success=true  drawn=90 wallet=0 used=90
09 beyond the credit line         success=false ... Credit Line Has 910.00 Left. Square Up ...
10 claim back half                success=true  repaid=45 wallet=5  used=45
11 claim back the remainder       success=true  repaid=45 wallet=10 used=0
12 mint a wallet for the owner    success=true  unchanged=true club_role_now=owner
13 promote a row holder to co_owner  success=true  rates_now=0.0000/0.0000
```

Gates: `tsc --noEmit` clean on client and server; **730 test files, 10,266 tests
passing**; `check-migrations-applied.mjs origin/main` OK; `check-title-case` OK;
37 new pins in `tests/a-credit-line-is-spendable.law.test.ts`, no existing pin
weakened.

## Found on the way, not fixed here

- **The migration ledger is missing rows.** `20260831235996`, `20260831235997`
  (phase 0) and `20260901000001` (phase 1) are live in the schema but absent
  from `supabase_migrations.schema_migrations`. This one was recorded. The gap is
  bookkeeping, not schema drift, but `list_migrations` under-reports because of it.
- **The "11 orphaned uplines" are not orphaned.** All 11 point at a club _owner_
  who holds an active agents row. Under Dan's correction that owners hold agent
  wallets, that is legitimate data, not a defect. B-05's first half dissolves.

## Not tested

The promote screen was not rendered live at 375px. The control is two `flex: 1`
buttons with a 44px minimum in the existing `.mm-roles__rates` card, pinned by
test, but a screenshot was not taken.
