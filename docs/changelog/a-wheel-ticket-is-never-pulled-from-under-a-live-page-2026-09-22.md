# 2026-09-22: a wheel ticket is never pulled from under a live page

The Diamond Wheel had the root cause the Diamond Games had until migration
`20260921185541` (2026-09-21, Shark Club: a page kept a dead game ticket and
got stuck). `public.fn_wheel_commit` began by deleting every unconsumed wheel
ticket the player held before it dealt a new one. The wheel page deals itself a
ticket when it loads and again after every spin, so a second page of the same
player (another tab, or a refresh during the maintenance break) destroyed the
ticket the first page was holding. The first page's next spin was refused with
"That Spin Ticket Is Not Yours Or Was Already Used. Open The Wheel Again".

## Shipped

- Migration `20260922032153_a_wheel_ticket_is_never_pulled_from_under_a_live_page`:
  `fn_wheel_commit` now sweeps only this player's **expired** unconsumed
  tickets (`expires_at < now()`, the same test the spin refuses on). The rest of
  the function is byte-identical to the live definition it replaced: the
  installed md5 equals the md5 of the old definition with only the sweep
  statement and its comment replaced. Grants, owner, `SECURITY DEFINER` and
  `search_path` are unchanged.
- One transaction with `lock_timeout = 2s` and `statement_timeout = 20s`, and a
  preimage check that refuses to install if `fn_wheel_commit`, or any spin path
  this change relies on, differs from the definition that was measured.
- Law `tests/a-wheel-ticket-is-never-pulled-from-under-a-live-page.law.test.ts`
  pins the expired-only sweep, and refuses any later migration that deletes
  from `wheel_seed_commits` without `expires_at < now()`.

No client, engine or spin function changed. The wheel client from PR #5054
already refuses cleanly on an answered error and prepares the next ticket.

## Why nothing needs one open ticket per player

Every function that reads or writes `wheel_seed_commits` was read in full:

| Function                                                                         | md5 (unchanged)                    | Ticket handling                                                                                                                                                                 |
| -------------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fn_wheel_spin_v2(uuid,uuid,text,integer,text,uuid)`                             | `cb2a22529dd1eeab1451d6e451747c58` | Live path. Selects `id = p_commit_id AND user_id = caller AND consumed_by IS NULL FOR UPDATE`, refuses once `expires_at < now()`, before the first money leg; consumes by `id`. |
| `fn_wheel_spin_core(uuid,uuid,text,boolean,uuid)`                                | `d2d449daa747be0d4ae53006cf0c8eba` | Retired: after its receipt replay it refuses every new spin with "Refresh Diamond Spins To Use The New Wheel". Its unreachable body makes the same passed-ticket check.         |
| `fn_wheel_spin_core(uuid,uuid,text,boolean)`                                     | `4c9c2645c10f7440951f15ffeca63d68` | Passes `p_commit_id` through.                                                                                                                                                   |
| `fn_wheel_spin(uuid,uuid,text)`                                                  | `f39ee4eb328f9c4176a982a7b009f76e` | Passes `p_commit_id` through.                                                                                                                                                   |
| `fn_wheel_welcome_spin(uuid,uuid,text)`                                          | `437ae1a74244f9aa819bf4066cfe824d` | Passes `p_commit_id` through.                                                                                                                                                   |
| `fn_wheel_daily_bonus_spin(uuid,uuid,text,uuid)`                                 | `d935f35758239ee605b47fb668f521e9` | Passes `p_commit_id` through.                                                                                                                                                   |
| `fn_diamond_bonus_spin_ticket_guard()` (trigger on `diamond_bonus_spin_tickets`) | `6771d97906576f09e64b58bd86e53d9e` | Checks owner, unconsumed and unexpired on `NEW.commit_id` before it mints.                                                                                                      |

No state function, view, cron job or other schema reads the table, and the
client (`DiamondWheelService.commit`, `DiamondWheelPage`) spins with the ticket
it was dealt or the one saved with its pending spin. `fn_wheel_spin_v2` already
serialises new entries across tabs with a per-player advisory lock.

Several live tickets give no edge. A ticket shows only `sha256(server_seed)`;
the seed is revealed by the spin that consumes it, in the same transaction as
the money. Nobody knows the seed behind any live ticket, so choosing between two
of them is choosing between two unknown uniform draws. The daily limit, the
pause between spins and the nonce are counted per spin, not per ticket.

Evidence: `wheel_seed_commits` held 80 rows; its only indexes are the primary
key and the non-unique partial index `wheel_seed_commits_user_open_idx (user_id)
WHERE consumed_by IS NULL`; no foreign key references it and no trigger is
defined on it; only `postgres` and `service_role` hold grants on it.

## Probes (production, each one transaction ending in RAISE, all rolled back)

Before install, as player `47965354-0e56-43ef-931c-ddaab82af765`:

> PRE-INSTALL PROBE (rolled back): fn_wheel_commit md5=34c775fe864cc754f30793582aa162ad | first ticket live after second commit=f | second ticket live=t | open tickets for player=1 | spin v2 with FIRST ticket -> {"ok": false, "error": "That Spin Ticket Is Not Yours Or Was Already Used. Open The Wheel Again"}

After install, on Shark Club (`a41434bb-8d0c-400a-8f0d-e8b3d65afed4`), through
the cheapest real path the state offered (a paid v2 spin at the 25 Diamond
minimum; this player has no welcome spin, being the host owner, and no daily
ticket):

> POST-INSTALL PROBE (rolled back): fn_wheel_commit md5=2325f279e9b3e5826cfdb9df996680a8 | after two commits: first live=t second live=t open=2 expired_open=0 | random-uuid ticket -> {"ok": false, "error": "That Spin Ticket Is Not Yours Or Was Already Used. Open The Wheel Again"} (diamonds 449840 -> 449840) | OLDER ticket spin ok=true error=<NULL> spin_id=529a1183-7939-49d5-9e5e-2ea0712f0d81 player_cost=25 entry=25 outcome_kind=bonus fairness_commit_is_older=t older_consumed_by_that_spin=t diamonds_after=449815 | newer ticket still live after the spin=t

Afterwards `wheel_spins` and `wheel_bonus_awards` held no row for that spin id,
`wheel_seed_commits` still held 80 rows and the player's balance was 449840.

## Installed

- Installed 2026-09-22 03:26 UTC through the Supabase MCP `execute_sql` with
  the exact file contents, outside the :50-:03 break window.
- `fn_wheel_commit` md5 `34c775fe864cc754f30793582aa162ad` became
  `2325f279e9b3e5826cfdb9df996680a8`; the old live-ticket delete is absent and
  the expired-only sweep is present; one overload.
- `supabase_migrations.schema_migrations` row
  `20260922032153 | a_wheel_ticket_is_never_pulled_from_under_a_live_page`.

## Limits

- A player can now hold several open tickets for up to 15 minutes each. Each
  deal inserts one row; the player's expired rows go on their next deal. This
  is the same shape the Diamond Games' tickets have had since `20260921185541`.
- Expired tickets of a player who never deals again stay in the table, as they
  did before (the old sweep also ran only on that player's next deal).
