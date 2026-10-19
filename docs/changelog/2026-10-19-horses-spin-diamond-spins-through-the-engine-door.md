# A horse spins Diamond Spins through the person's own wheel

**Owner request (Dan, 2026-10-18).** Every horse plays the Club Arena and the
Diamond Arena. A horse with no chips left grinds the Diamond Arena for
Diamonds and uses them on Diamond Spins to get chips again. This is Phase 3 of
that build: the door the game engine uses to spin for a horse.

## What was wrong

Every Diamond Spins door (`fn_wheel_commit`, `fn_wheel_spin_v2`,
`fn_wheel_bonus_start`, `fn_choice_act`, `fn_crash_cashout`,
`fn_crash_settle`, `fn_wheel_diamond_cards_pick` and the games' own commits)
finds its player with `auth.uid()` and nothing else. A horse has no browser and
no session, so the wheel sat behind a door only a browser could open.

## What changed

Migration `20261019023857_horses_spin_diamond_spins_through_the_engine_door`
adds `public.fn_horse_diamond_spins(p_horse_id, p_action, p_args)`:

- **Engine only.** `fn_caller_is_engine()` in its own body; `EXECUTE` is
  revoked from `PUBLIC`, `anon` and `authenticated` and granted to
  `service_role` alone.
- **Horse only.** `profiles.is_horse` must be true for the player it names.
  It can never play as a person.
- **The person's own functions.** Each of eleven actions (`wheel_state`,
  `wheel_commit`, `wheel_spin`, `game_commit`, `bonus_state`, `bonus_start`,
  `choice_state`, `choice_act`, `crash_cashout`, `crash_settle`,
  `cards_pick`) calls the exact public function the Diamond Spins page calls,
  with the arguments the page sends. There is no second copy of the wheel:
  prize table, seeds, entry range, membership, owner terms, limits, bonus
  queue, pools, caps, ledger legs and the platform freeze are all the person's
  code, because the person's function is what runs.
- **The engine's identity comes back.** The horse is named as the caller with
  the same transaction-local `request.jwt` claims PostgREST sets for a
  signed-in player, and the engine's own claims are restored before the door
  returns.

It decides nothing (when a horse is broke, how much it spins, which bonus moves
it makes are the engine's, as they are the browser's for a person), moves no
money itself and writes no balance column. No table, cron or repair path.

## Proof, rolled back (CLAUDE.md 11.5)

Every probe was one Supabase call ending in `RAISE EXCEPTION`, so nothing
committed. The door's exact body was created in `pg_temp` inside the same call.
Horse `93ecbb64-e602-47f1-a314-056504d6b3be` at Club JAQK (Midway Union host):

| Through the door                 | Result                                                              |
| -------------------------------- | ------------------------------------------------------------------- |
| a person (not a horse)           | refused, "Only A Horse Spins Through This Door"                     |
| an unknown action                | refused, "Unknown Diamond Spins Action"                             |
| a browser caller                 | refused, 42501                                                      |
| paid spin, 100 Diamonds          | 1x Chips: Diamonds 113,415 to 113,315, chips 3,455.35 to 3,456.35   |
| a second spin in the same second | refused, "One Moment Between Spins" (the person's rule)             |
| spin landed Donkey Cross         | game commit, bonus start ok, round sealed with its ladder and proof |
| spin landed Diamond Crash        | game commit, bonus start ok, round open on the server clock         |
| after every call                 | `auth.uid()` NULL again, `fn_caller_is_engine()` true               |

Read afterwards: the horse still held 113,415 Diamonds, with no spin, award or
seed commit in the last two hours.

## Installed and checked live

Installed 2026-10-19 02:38:57 UTC (recorded as version `20261019023857`; the
file was renamed to match). Read back: the function exists, is SECURITY
DEFINER, is not executable by `anon` or `authenticated`, and is executable by
`service_role`. Then one rolled-back call through the installed door: a person
refused, a browser caller refused 42501, and a paid 100-Diamond spin for the
horse took 100 Diamonds and landed Donkey Cross, funded by the player, on the
wheel-v4 table; afterwards `auth.uid()` was NULL and the engine identity
restored. Nothing committed.

## Pinned by

`tests/a-horse-spins-through-the-persons-own-wheel.law.test.ts`
(`docs/laws.d/a-horse-spins-through-the-persons-own-wheel.md`).

## Not in this phase

This phase is the door only. No engine code calls it yet, so nothing changes for
any horse until the engine side ships.
