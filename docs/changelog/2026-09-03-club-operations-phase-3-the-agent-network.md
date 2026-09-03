# Club Operations, Phase 3 of 8: the agent network's controls reach something

**Branch** `feat/club-operations-full-upgrade` - **Migrations**
`20260903200000_an_agent_payout_is_a_record.sql`,
`20260903210000_the_payables_read_is_index_only.sql`

Four controls across the agent pages could not do what their labels said, and
each failed for a different reason.

## The four dead controls

**Ban Player was a toast.** The whole branch:

```
else if (type === 'ban') { toast.success('Player banned'); }
```

No write of any kind. The confirm dialog collected the player id and discarded
it. Nobody who pressed that button has ever banned anybody.

**Clawback was dead three times over.** Any one of these would have been fatal
on its own:

1. The list filtered `transaction_type` in `('agent_to_player',
'promo_agent_to_player', 'send')`. Those three types have **zero rows in
   `chip_transactions`, estate-wide.** The only agent distribution type is
   `agent_wallet_send`, of which there are 416. So the panel has been empty on
   every club since it shipped and the button under it has never rendered once.
2. It began by UPDATEing `chip_transactions` to stake the row. That table
   carries SELECT policies only, so the update matched zero rows and the method
   returned "Transaction already clawed back or claim failed" - naming a cause
   that was never true.
3. `fn_clawback_chips_atomic` is `SECURITY INVOKER` and `authenticated` holds
   no EXECUTE on it. Even reached, it updates `agents` and `wallets`, neither of
   which grants a browser a write.

**Add Prepaid Balance could never succeed.** It called
`setCreditLine(..., isPrepaid: true)` passing the amount as the credit _limit_.
`fn_admin_update_agent` refuses exactly that pair: _"a prepaid agent carries no
credit line"_. Every positive amount was rejected.

**Revoke Credit did not touch credit.** It called `wallet_user_transfer` -
also invoker, also ungranted - and had it run, it would have moved chips out of
the agent's own player wallet into the signed-in owner's player wallet, leaving
`credit_limit` and `credit_used` exactly where they were.

## And the payables screen was arithmetic, not a ledger

"Upcoming Agent Payouts" computed `weekly_rake_generated * commission_rate` per
row and stamped a hardcoded `Pending` beside it. No payout, settlement or
commission table was read anywhere in that file. Against Deep Stack Society on
the day it was replaced:

| role           | page showed | actually owed | commission rows |
| -------------- | ----------- | ------------- | --------------- |
| super_agent    | 2,565.63    | **10,061.40** | 34,162          |
| super_agent    | 2,404.85    | **8,859.80**  | 33,845          |
| agent          | 3,249.79    | **4,459.66**  | 13,796          |
| **club total** | **36,657**  | **65,790**    | **259,135**     |

Every one of those rows has `settled_at IS NULL`. The club is carrying 65,790
chips of unpaid commission and its own payables screen reported a little over
half of it.

This needed a function rather than a query: `agent_commissions` grants
`authenticated` exactly one read, `user_id = auth.uid()`, so a club owner has
no policy on that table at all and the honest number is not reachable from the
browser by any means.

## What shipped

`fn_ca_can_manage_agents` is the gate - owner, co-owner or admin, the same
three roles `fn_admin_update_agent` authorizes for writes, and it requires an
account. `fn_ca_agent_payables` reads the commission ledger and returns, per
agent, what is owed, how many earned rows are behind that figure, how old the
oldest is, and the funding position. It carries the old estimate alongside, and
the page prints both, so an operator who has been reconciling against the old
number sees the two together rather than finding it silently changed.

`fn_ca_ban_club_player` writes the `blacklists` row, which is not a label:
`atomic_table_buyin`, `atomic_table_rebuy` and `atomic_tournament_register` all
read that table, so the exclusion stops the player buying in, rebuying and
registering. It fires the `player_banned` audit event through the existing
trigger.

**It deliberately does not delete the membership, and the probe is why.** The
first draft did. `club_members` carries `chip_balance`, `held_chips`,
`locked_chips`, `promo_balance` and `credit_used`, and the very first member
the probe picked was holding **10,067.64 chips** - deleting that row destroys
them, which is the same class of mistake as closing a seat outside a cash-out
(CLAUDE.md 11.5). It returns the balance, the credit drawn and the count of
live seats instead, and the console reports all three to the operator and
offers the engine removal for the seats.

The clawback panel now reads `fn_agent_wallet_reversible` and acts through
`fn_agent_wallet_claim_back` - both definer, both granted, both what
`WalletCashierModal` has been calling correctly all along. **No new money code
was written.** The dead parallel implementation was deleted and the UI pointed
at the one that works, including its retry key and the database's own clock.

Prepaid funding is `fn_agent_wallet_send` into the agent wallet, because
funding a prepaid agent means sending them chips. Revoking credit is
`CreditService.lowerCreditLine`, which lowers the line through
`fn_admin_update_agent` and lets that function refuse on its own terms when the
agent has already drawn more than the new limit. The three actions are now
labelled for what they do: Set Credit Line To, Send Prepaid Chips, Reduce
Credit Line By.

## Smaller things that were wrong

- **The hierarchy Transfer sent `agent.id`**, the `agents` primary key, where
  the identical button on the Agents tab sends `agent.userId`. The modal matches
  its recipient against `club_members`, so a transfer started from the tree
  opened on a blank recipient.
- **Credit Limits labelled every `super_agent` "Sub-Agent"** - a two-branch
  ternary over three roles, disagreeing with the tab above it about the same
  person. One `AGENT_ROLE_LABELS` map now, on both pages.
- **The agent dashboard read a different downline than the rest of the app.** It
  used `club_members.invited_by`; every write path uses `agent_id`. Estate-wide,
  1,575 memberships carry an `agent_id` and 417 an `invited_by`, so every count
  on that page was computed over a different set of people.
- **`getAgentPlayers` had no club filter**, so SuperAgentDashboard's player
  list, its count and its transfer picker showed the agent's players from every
  club - while the transfer it then made was scoped to the club being viewed.
- **`fn_create_agent` received an unresolved club param**, so Create Agent
  failed on any club URL that was not already a uuid.
- The credit and transfer forms collected a note and threw it away;
  `credit_assignments` has been recording the constant "Credit line issued" for
  every change ever made.
- A Cancel button with no content - an emoji stripped, the empty wrapper left -
  sitting beside Save as an invisible control only a screen reader could find.
- Counts printed without separators, and a raw `super_agent` enum shown as a
  role.

## Performance

The payables aggregate walked 88MB of heap: the existing partial index found
the club's rows in 375 buffers and then visited 3,313 heap blocks per worker for
`amount` and `created_at`. Cold, that is **5,198ms**. Carrying those two
columns into the index makes the scan index-only - `Parallel Index Only Scan`,
3,044 buffers against 11,262 - and the call now runs **1,731ms cold and ~450ms
warm**. Worth recording: 2,054,257 of the table's rows are unsettled, because
nothing on this estate has ever been marked settled, so `settled_at IS NULL` is
not yet a selective predicate. It is the correct one, and it will start doing
real work the first time a settlement run marks a period paid.

## How it was verified

Live, against production, as the real user, inside a transaction that is rolled
back:

- A plain club member is refused `42501` by both `fn_ca_agent_payables` and
  `fn_ca_ban_club_player`; the gate returns false for them and true for the
  owner.
- The owner's ban writes one `blacklists` row and one `player_banned`
  `anti_cheat_events` row, and returns the member's held chips, credit drawn and
  live seat count.
- Banning the club owner returns `cannot_ban_the_owner`; banning a
  non-member returns `not_a_member_of_this_club`.
- After the rollback, zero blacklist rows remain.

Gates: `all-gates.sh` plus `entry-chunk-delta` and `check-migrations-applied`,
`check-applied-migrations-are-recorded`, `check-definer-authorization`,
`check-phantom-tables`, `check-phantom-columns`, `check-route-targets`,
`check-painted-text-case`, `check-maybe-single`, `check-bus-wiring`,
`check-db-copy`, `check-required-columns`, `check-no-orphaned-work`,
`check-embed-relationships`, `check-horses-are-players` and `npm run lint`. All
green. 32 new cases in
`tests/unit/theAgentNetworkReachesSomething.test.ts`.

One baseline moved and one fault was caught by a ratchet rather than by me:
`discardedErrorReadRatchet` failed because `lowerCreditLine` dropped the error
on the read that decides the new limit - on a money path, where a failed read
and "this agent has no line" must not look the same. It is bound and thrown
now. `AgentService.ts` went 12 to 11 in the same ratchet when the dead clawback
path was deleted, and its baseline is lowered in this commit.
