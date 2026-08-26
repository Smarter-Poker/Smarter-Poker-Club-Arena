# 2026-08-26 — ~180 public tables are readable with the publishable key, no login

**Status: REPORTED, NOT FIXED. This needs a human decision, not an agent.**

Found while closing out the `multiple_permissive_policies` advisor item. Two of
the duplicate-policy tables turned out to be duplicated for the same reason: one
narrow owner policy sitting next to one whose `qual` is literally `true`. Pulling
that thread found ~180 of them.

## What was verified

Not inferred from policy text — actually requested, against production, with the
**publishable (anon) key** and no session:

```
GET /rest/v1/<table>?select=*&limit=1
apikey: sb_publishable_…      (the key the browser bundle ships with)
```

| Table                 | HTTP | Returned                                                                      |
| --------------------- | ---- | ----------------------------------------------------------------------------- |
| `horse_personality`   | 200  | `aggression_level`, `humor_level`, `technical_depth`, `contrarian_tendency` … |
| `horse_memory`        | 200  | stored `POST` memories with content                                           |
| `table_seats`         | 200  | live seat rows (137,832 est.)                                                 |
| `friendships`         | 200  | `user_id` / friend pairs (14,833 est.)                                        |
| `player_stats`        | 200  | per-user stat rows (1,732 est.)                                               |
| `club_arena_messages` | 200  | `[]` — permitted, but the table is empty                                      |

Five of six returned real rows to an unauthenticated caller.

## The shape of it

```sql
SELECT DISTINCT tablename FROM pg_policies
 WHERE schemaname='public' AND cmd='SELECT'
   AND qual='true' AND 'public'=ANY(roles);
```

returns roughly 180 tables. `public` in Postgres includes `anon`, and each of
these also carries an `anon` SELECT grant, so RLS is not gating them at all.

## Why this is not being "fixed" here

**Most of these are correct.** smarter.poker is a public poker-information site:
`venues`, `poker_news`, `poker_events`, `poker_series`, `leaderboard_entries`,
`training_*`, `trivia_questions` and dozens more are _supposed_ to be world
readable. Revoking broadly would break the product immediately.

The judgement of which are intentional is a product decision. An agent that
guesses wrong here either breaks the site or leaves a hole. So: triage list, not
a migration.

## Suggested triage order

1. **`horse_memory`, `horse_personality`** — the platform's model of how its
   AI personas behave and what they remember. Reading it is an integrity
   question, not just a privacy one.
2. **`friendships`, `social_message_reads`, `player_stats`** — per-user social
   graph and statistics, exposed to anyone with the bundle's key.
3. **`table_seats`** — 137k live seat rows. Stacks at your own table are public
   by the nature of poker; every seat at every table across every club is a
   different proposition.
4. **`club_arena_messages`, `user_media`, `user_albums`, `page_claims`,
   `venue_claims`, `crew_members`, `toke_entries`** — currently empty or tiny,
   so no live exposure, but the policy will permit it the moment they fill.
5. Everything else — most likely intentional, worth one pass to confirm.

The fix for each is the same shape: replace `USING (true)` with the real
predicate, or drop the `true` policy where a narrow owner policy already exists
beside it (which is exactly the case on `survival_progress` and
`trivia_pvp_matches`).

## What WAS done in this sweep

`multiple_permissive_policies` went 12 -> 11. Only one group was safe for an
agent to collapse unilaterally:

`public.message_reactions` had two permissive SELECT policies for
`authenticated`, and the narrow one's condition was exactly the first three
disjuncts of the broad one — strictly subsumed, so `broad OR narrow === broad`.
Dropped `msg_reactions_select`; migration
`20260826_drop_subsumed_message_reactions_select_policy` carries the proof and a
rollback.

The remaining 11 groups are not duplicates in the same sense. Nine pair a
specific policy with `union_overseer_read` on money and permission tables
(`club_members`, `club_wallets`, `club_wallet_transactions`, `agent_commissions`,
`credit_requests`, `settlement_invoices`, `sub_agents`, `agents`, `audit_trail`)
— those two conditions are genuinely different and must be OR'd. Collapsing them
means rewriting money-table RLS by hand for a small planner saving. Not worth the
blast radius while twenty agents are shipping into the same schema.

The other two (`survival_progress`, `trivia_pvp_matches`) are the `USING (true)`
case above, and belong to the security decision, not the performance one.
