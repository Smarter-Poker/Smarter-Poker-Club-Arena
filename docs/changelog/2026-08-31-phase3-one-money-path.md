# Phase 3 of 7: one money path

**2026-08-31.** No migration. Client only, plus one finding that stops a
migration the plan called for.

Dan, 2026-08-25, binding: _"Any chips sent or claimed back transact from the
Agent Wallet."_ And 2026-08-31: _"CHIPS MUST FLOW FROM THE MAIN BANK TO THE
AGENT WALLET TO SEND OUT TO AGENTS AND PLAYERS."_

## What was wrong

`ChipTransferModal` was a **fourth money path**, and it moved the wrong
accounts. It called `ChipFlowService.clubToAgent` / `clubToPlayer` /
`agentToPlayer` — all three peer-to-peer moves between two users' **player**
wallets on `atomic_chip_transfer`:

1. `clubToAgent` debited the **owner's personal wallet**, never
   `clubs.chip_treasury`, despite being named for the club bank.
2. `agentToPlayer` debited the agent's own **player** wallet, never
   `agents.agent_wallet_balance`. Its own doc comment said so.
3. The balance it displayed **and validated against** was the viewer's global
   player wallet, which is not the account any of those sends debited. An agent
   with an empty personal wallet and a funded agent wallet was refused by their
   own browser.
4. No idempotency key, so a lost response and the obvious retry sent twice.
5. No downline check, and a recipient list that offered an agent the entire
   club, so the modal advertised transfers the server refuses.
6. No result check, so a refusal from the RPC still printed "Transferred".

`CashierPage.tsx:1430-1455` documented this exact bug when the Cashier was fixed
on 2026-08-27. The Cashier was fixed and the modal was left behind.

## What changed

- **`ChipTransferModal`** now makes the same two calls every other cashier
  surface makes: `fn_club_bank_send` for the four bank roles,
  `fn_agent_wallet_send` for the three agent roles, routed from
  `CLUB_BANK_ROLES` (the one place that rule lives) and with the destination
  derived from the recipient via `canHoldAgentWallet`. Every send carries a
  uuid `p_op_id` from the shared `utils/uuid` helper, held across a retry and
  rotated only when the recipient or amount changes. The result is checked.
- **The balance on screen is the account that gets debited** — club treasury for
  a bank role, agent wallet for an agent — and an unreadable balance is
  `null` (unknown), never a confident zero that would block a valid send.
- **The recipient list asks the database.** Agents get `fn_club_cashier_members`,
  which walks the same recursive `club_members.agent_id` edge that
  `fn_club_cashier_can_transact` refuses on, with the self-send filtered out.
- **A send funded from the credit line says so** (`credit_drawn` from phase 2),
  because that is a debt and not float.
- **`ChipFlowService.clubToAgent`, `agentToPlayer` and `clubToPlayer` are
  deleted.** The generic `transfer` stays: it is a real player-to-player move and
  `AgentService` still uses it.

## The plan said to drop a function. It was wrong, and I did not.

The Phase 3 plan said `DROP FUNCTION transfer_chips_agent_to_player`, on the
recorded basis that it has **zero callers**. It has four, and dropping it would
have caused two failures at once:

1. **A live World Hub API route calls it.**
   `pages/api/club-arena/distribute-chips.js:166` invokes it for the agent
   branch, and `AgentService.ts:1170` reaches that route through
   `callClubArenaApi('distribute-chips', ...)`. Dropping it would have returned
   a 500 from a production endpoint.
2. **The estate's own integrity check requires it to exist.**
   `fn_union_money_path_check` lists it and says, in its own comment: _"A
   function that has been deleted outright is still a breach."_
   `fn_club_arena_global_wallet_check` and `fn_union_overload_check` also name
   it.

So it stays, and the remaining work is a **World Hub** change rather than a
Club Arena one: rewire `distribute-chips.js` onto `fn_agent_wallet_send`, update
the three integrity-check lists in the same migration, and only then drop it.
That is a different repo and a different deploy, so it is reported rather than
bundled in here.

Worth knowing while it stands: `transfer_chips_agent_to_player` debits
`club_members.chip_balance`, so that API route is itself a wrong-account path.
It is also the second implementation of the credit-draw rule, phase 2 having
ported the first onto `fn_agent_wallet_send`.

## How it was verified

Probed against production inside a transaction that was **rolled back**
(`CLAUDE.md` §11.5). Nothing was kept.

```
BANK   success=true  treasury 1,000,000 -> 999,500 (d=-500)
                     OWNER personal 495,456.23 -> 495,456.23  (d=0)
                     player d=+500
AGENT  success=true  float 50,000 -> 49,300 (d=-700)
                     AGENT personal 24,993 -> 24,993  (d=0)
                     player d=+700
RETRY  success=true  replayed=true  float still 49,300  player still +700
```

The two `d=0` lines are the whole phase: the accounts the old code debited no
longer move, and the accounts Dan named do. The retry line is the idempotency
key doing its job.

Gates: `tsc --noEmit` clean on client and server; full suite green;
`npm run build` clean; title case and UI text OK. 19 new pins in
`tests/one-money-path.law.test.ts`, no existing pin weakened.

## Not done here

- The World Hub `distribute-chips` route (above) — a cross-repo change awaiting
  Dan's call on scope.
- `transfer_chips_agent_to_player` is therefore still callable, and still the
  loaded gun the audit called it.
