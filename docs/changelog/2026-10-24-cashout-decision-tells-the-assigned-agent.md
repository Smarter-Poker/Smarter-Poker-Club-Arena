# 2026-10-24 - A cash-out decision tells the agent it was assigned to

Dan, 2026-10-24, on the Transaction History follow-ups: "GO AHEAD AND FULLY
BUILD, FIX AND ENHANCE ALL OF THESE". One of them: tell the assigned agent
when somebody else accepts or cancels his player's cash-out.

## What was wrong

A cash-out request goes to the player's agent. Since 2026-10-23 any owner,
co-owner or admin can accept or cancel it, and the chips go to whoever
accepts. The decision's audience was {club owner, player, the person who
decided}, so the agent who had been asked was never told. Read on production:
CA-2026-00012497, Golddigger's 20.00 was assigned to DarthBayter and accepted
by KingFish; only KingFish and Golddigger got the decision.

## The fix

Migration `20261024220301_cashout_decision_tells_the_assigned_agent` changes
the one audience line in `fn_cashier_cashout_transition`: for an approval or a
decline the assigned agent is added, when he still has a profile (a removed
agent must never stop a payout). `array_agg(DISTINCT)` already folds him away
when he is the one deciding. The bell copy is unchanged: a recipient who is
neither the player nor the decider already gets the third-party line ("X's
Payout Of 20.00 Chips Was Accepted").

The rewritten definition was compiled in `pg_temp` on production (rolled back)
before shipping; the live line was confirmed present exactly once (function
md5 `3f01c29cb551e8de6f1b470dca2c9ff5` before).

## Pinned

- `tests/the-assigned-agent-hears-the-decision.law.test.ts`
- `tests/fixtures/cashier-document-authority/regression.sql` installs the same
  line and asserts an admin acceptance reaches exactly owner, player, accepter
  and assigned agent, and an admin cancellation reaches the assigned agent
  (binding restamped in `tests/fixtures/full-weekly-accounting/source-binding.json`).
