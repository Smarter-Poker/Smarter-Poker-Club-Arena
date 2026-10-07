# 2026-10-06: The Diamond Arena spawns the Midway Union's schedule (database half)

## The ruling

Dan, 2026-10-06 13:09 CT, verbatim: "USE THE SAME TOURNAMENT SCHEDULE AND RAKE AS THE MIDWAY UNION FOR NOW", for the Diamond Arena (club `002c2d27-9584-4e52-835a-bb2be148fc81`, union_id NULL). Midway's 63 active `tournament_schedules` rows are the schedule. This change is the database half: the door the engine spawns those rows through, and the guarantee and freeroll money paths they need. It seeds no schedule row, mints nothing and is not applied to production by this branch; the lead applies it after review.

## What it does

Migration `supabase/migrations/20261007000010_the_diamond_arena_spawns_the_midway_schedule.sql`, one transaction:

- **One creation core, two doors.** `fn_poker_diamond_create_tournament_core(p_config, p_authority)` is the live creation door's body (md5 `05e4ae64...`) with every validation kept. The staff door `fn_poker_diamond_create_tournament(jsonb)` keeps its authority (platform admin with a live session) and its audit row. The new scheduled door is service_role only:

  `fn_poker_diamond_spawn_scheduled_tournament(p_schedule_id uuid, p_scheduled_start timestamptz, p_config jsonb) RETURNS jsonb`

  It requires an active Diamond Arena schedule row with union_id NULL and the arena's tournaments open. It is idempotent per (schedule, start) through `ca_diamond_scheduled_spawns`, and it returns `{ok, tournament_id, replayed}` or `{ok:false, reason}`. Every p_config key it reads is listed in the migration header.

- **Fee:** Midway's 10%, or 5% at a 2-seat cap, rounded down to a whole Diamond. This is the rule the door already ran, so a 3 or 5 Diamond entry pays nothing.
- **Guarantees, on the live path (no sweep):**
  - **Creation:** opens a `guarantee:<id>` earmark on `ca_diamond_house` before the row exists. The earmark covers the guarantee, or for a satellite the seats times the target ticket. The earmark guard refuses anything over A4, A5 or what the house has available.
  - **Readiness and affordability:** `trg_tournaments_guarantee_affordable` and the readiness contract read that earmark instead of a chip bank.
  - **Lock:** `fn_ca_fund_overlay_on_lock` calls `fn_poker_diamond_tournament_settle_overlay`. It pays the shortfall from the house into the entry custody, built on the Spin underwrite's template: a house burn, then a player-registered credit, a movement and an `overlay` ledger row for each share. The earmark records the payment and the rest is released.
  - **Pool close:** `fn_apply_prize_guarantee` returns any overlay that later entries made unnecessary (`overlay_return`). This makes the guarantee a floor, as it is for chips.
  - **Cancel and completion:** both release whatever is still earmarked.
- **Freerolls:** a buy-in of 0 is allowed with a guarantee. Rebuys and add-ons cost 1 Diamond each and all of it goes to the pool, as Midway runs them. The human and horse registration cores open a zero-balance active entry custody row (`fn_poker_diamond_tournament_free_entry`). The refund door releases that row at zero. A new `ca_diamond_economics` row records the A11 answer `one_diamond_to_the_prize_pool` with the reason "Dan 2026-10-06: same tournament schedule and rake as the Midway Union".
- **Bounties:** on the scheduled door a bounty that is not a whole Diamond (Midway's 2.5 or 6.75) is rounded down, and the remainder stays in the prize part.
- **Horses:** nothing reads is_horse. A horse registers, rebuys and is paid through the same doors (CLAUDE.md 10.5).

## What the runner proves

`tests/sql/run-diamond-scheduled-tournaments.py` uses an isolated PostgreSQL 17 cluster that it creates and then destroys. It loads production's live bodies, each pinned by md5 in `diamond-scheduled-tournaments-prerequisites.sql`, and applies the migration verbatim. It then proves the following through the real doors:

1. A signed-in player has no EXECUTE on the scheduled door. A caller whose JWT is not service_role gets `service_role_only` and nothing is created.
2. A spawn is priced as Midway prices: 10 becomes 9 + 1, 5 and 3 pay no fee, and 100 at a 2-seat cap becomes 95 + 5. The schedule is recorded, union_id is NULL, and the event is recognised as a Diamond event.
3. A replay of the same (schedule, start) returns the same tournament with `replayed:true` and creates nothing.
4. A 100 guarantee opens a 100 earmark at creation. No Diamond moves. A guarantee over the per-event cap, or over what the house has available, is refused by name and writes nothing.
5. Two humans and a horse each pay 10 from their own wallet and get identical ledger rows.
6. At lock, the 73 shortfall moves from the house into custody (25, 24 and 24). The pool becomes 100 and custody becomes 103, which equals the banks. The earmark records pay 73 and releases 27. The crossing is a registered pair.
7. A human and a horse are each paid 50 through the same journal type and class.
8. At completion the 3 fees reach the house, custody closes and nothing is left earmarked.
9. Cancelling a guaranteed event refunds the entry and releases the whole earmark.
10. At pool close, overlay that a later rebuy made unnecessary (9) returns to the house, and the pool stays at the 30 floor.
11. A freeroll spawns free with its guarantee set aside, and one without a guarantee is refused. A human and a horse enter for nothing. A free entry withdraws at zero. At lock the house funds the whole 100. A 1 Diamond rebuy and a 1 Diamond add-on carry no fee and lift the pool to 102.
12. A bounty of 2.5 becomes 2, so an entry is 7 to the pool + 2 bounty + 1 fee.
13. The staff door still refuses a player.

After every step the supply identity is whole and every Diamond event's banks equal its custody.

## Not done here

- The 63 schedule rows are not seeded; a later step does that.
- The house is not minted; the owner does that.
- The engine change that calls the new door is a separate task. That task has to snap buyIn, rebuyCost and addonCost to whole Diamonds, resolve presets into blindStructure and payoutStructure, and resolve satelliteTargetName into satelliteTargetId.
- Satellite seat guarantees take the same earmark and overlay path, but the runner does not exercise a satellite.
- The fixture world comes from older captures. The runner adds production's columns for a few ticket and ledger tables so that the horse registration chain plans. It does not exercise the engine's launch RPC; the start is emulated with the launch receipt and its transaction marker.
