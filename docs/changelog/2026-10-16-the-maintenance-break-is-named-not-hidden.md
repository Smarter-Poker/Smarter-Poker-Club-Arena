# 2026-10-16: The maintenance break is named, not hidden

Dan, with a screenshot of Club JAQK's cashier (Send Out, Main Bank to Johnny,
1,000, "1 Need Outcome Verification / Transfer Failed"): "I CAN'T SEND CHIPS
FROM THE MAIN BANK TO AN AGENT INSIDE OF CLUB JAQK, FIX ANY AND ALL ISSUES AT
THERE ROOT CAUSE AND ANY OTHER SIMILAR BUGS."

## What actually happened

`cashier_operations` holds three failed sends for Club JAQK, at 23:58:56,
23:59:08 and 00:56:25 UTC. All three are inside the hourly maintenance break
(:55 to :00), where `zz_freeze_guard` refuses every chip write with SQLSTATE
55006 `PLATFORM_FROZEN`. A rolled-back probe as Dan at 00:58 UTC reproduced
exactly that refusal (`UPDATE on club_members was refused` inside
`fn_club_bank_send_core_20261004`). The same send probed at 01:01 UTC, after the
thaw, succeeded to both Johnny's Player Wallet and his Agent Wallet, with every
commit-time ledger check passing. Nothing moved on the failed attempts.

So the send path works. The defect is that nothing told Dan it was the break:

1. `fn_cashier_batch_transfer` wraps every item exception as
   `{"error":"Transfer Failed","error_code":"55006"}`, and
   `cashierBatchAcknowledgement` ignored `error_code`.
2. The cashier headed every failure "N Need Outcome Verification", including
   definitive refusals where there is nothing to verify.
3. Confirm stayed live during the break.
4. Across the app, `safeErrorMessage` (which every toast passes through) did
   not know the freeze: the raw text failed its allowlist on the underscore
   and became "Something Went Wrong". Inline renders showed the raw database
   text, and several flows filed the freeze under "unconfirmed".

## Fixes

- `src/utils/safeErrorMessage.ts`: the freeze is recognised first (object
  code 55006, reason, or the `PLATFORM_FROZEN` token) and returns
  `PLATFORM_FROZEN_MESSAGE`; `shouldSurfaceError` always surfaces it. This one
  change covers every toast in the app.
- `src/utils/cashierBatch.ts`: an item refused with `error_code` 55006 says the
  break.
- `CashierTradePage`: failures carry `refused`; the panel heads definitive
  refusals "N Not Sent" and only unknown outcomes "Need Outcome Verification";
  the toast follows. Confirm and Claim Back are held while the break is
  counting down, finalizing or resuming, and the hint line says why.
- Inline and "unconfirmed" paths now show the break: CashierPage (send,
  distribute, cashout), Union Treasury and Union Wallet modals, Agent Promo
  panel, Super Agent and Agent Portal transfers, AgentService and
  WalletService agent sends and claim back, cashout, cash buy-in refusal text
  (`cashBuyInRefusalText`), bust rebuy, tournament rebuy and add-on (no
  "unconfirmed" flag), tournament register and unregister, member leave,
  credit payment, cashier ticket service, and the cash-game seat/join refusal
  maps.

## Retry keys are kept

A freeze refusal moved nothing, but every path above keeps its retry key or
operation id rather than retiring it: a repeat after the break either replays
a committed earlier attempt or runs fresh, and keeping a key is never what
moves money twice (the Union Wallet comment records the time retiring one
did). The only exception is the existing cashier batch rule, where the
server's exact-intent wrapper answers a replay before the frozen write is ever
attempted.

## Not changed

No database change. `fn_cashier_batch_transfer` already returns the SQLSTATE;
the client now reads it.
