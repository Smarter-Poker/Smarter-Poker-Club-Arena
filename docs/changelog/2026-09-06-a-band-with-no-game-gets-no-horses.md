# A band with no game gets no horses

**2026-09-06.** The merit stake ladder is now projected onto the bands that
have an enabled cash game, in the assignment function itself, so the fleet
stops minting horses into a band nobody can sit in.

Migration `20260906093032_a_band_with_no_game_gets_no_horses.sql`, applied to
production and stamped the same day.

## Dan's ruling

> "THATS FINE, WE DON'T NEED ANY GAME OVER 2/5 RIGHT NOW."

So the six games above 2/5 stay closed: 5/10 NLH Classic, Action and Madness,
5/10 PLO4 Classic, 10/20 NLH, 25/50 NLH. An operator switched them off on
2026-09-04 at 16:47 and that is deliberate. **Nothing here opens a game.** This
is about the horses.

## The measurement

Read from production before the change:

| horses by `profiles.horse_profile->>'stakeBand'` | enabled `cash_games` by `fn_cash_stake_band(bb)` |
| ------------------------------------------------ | ------------------------------------------------ |
| micro 198                                        | micro 59 (bb 0.02 to 0.50)                       |
| low 521                                          | low 33 (bb 1.00 to 2.00)                         |
| mid 181                                          | mid 16 (bb 5.00)                                 |
| **high 100**                                     | **high 0** (6 games, all `enabled = false`)      |

100 horses held a band with no game in it. `stakeBandAllows` in
`server/src/services/HorseBehavior.ts` is a hard gate whose comment says "NO
ESCAPE HATCH, DELIBERATELY", so a tenth of the fleet could sit nowhere at all.

The cause was in `fn_assign_horse_stake_bands`: it ranks the fleet by bb/100
over `player_stats` and cuts it at percentiles hardcoded 22 / 74 / 89, with no
reference to `cash_games` at all. `pg_get_functiondef(...) ILIKE '%cash_games%'`
was false. It could not know a band was empty, so it went on minting 'high'
horses every time it ran. Rolled back on production the same day, the OLD
function run against today's data would have put **104** horses in 'high'.

## The fix

The merit ORDER is untouched: same bb/100 metric, same 1000-hand floor, same
cut points, same hysteresis. What changed is that the band the ranking names is
then projected onto the ladder of bands that have at least one enabled game.

Three functions, one transaction (production DDL policy, CLAUDE.md section 2):

- `fn_available_stake_bands()` - the bands with at least one `enabled` cash
  game, low to high, derived from `cash_games` and `fn_cash_stake_band(bb)`,
  never from a constant. A dormant-but-enabled game counts: it is a rung the
  ladder manager wakes on demand. A closed game does not.
- `fn_project_stake_band(band, available)` - downward only. A band with a game
  keeps its horses; a band with no game hands its horses to the highest band
  BELOW it that has one; a horse is never promoted, and if only bands ABOVE it
  are open it keeps the band it has. This is `projectStakeBandOnto` in
  `HorseBehavior.ts`, statement for statement.
- `fn_assign_horse_stake_bands(...)` - projects the merit band, and projects
  AGAIN after the hysteresis branch. The second projection is load bearing:
  hysteresis holds a horse near a boundary in the band it already has, and that
  band may be one the operator has since closed. Without the clamp the 100
  'high' horses survive their own repair.

**Fail open.** If no cash game is enabled at all, the function returns having
changed nothing and every horse keeps its band. An unreadable floor is not an
empty one, and an assignment that empties the fleet is the shape that cost 40
minutes of dead floor on 2026-08-31.

**The engine fallback (#3224) is kept.** `effectiveStakeBandFor` /
`applyStakeBandSupply` still drop a horse one band at seating time. It is the
belt to this braces and it covers the one window the SQL cannot: between an
operator switching a game off and the next assignment run. What changed is that
it is no longer load bearing forever.

## Before and after, on production

The migration calls the function, because nothing else would have:
`HorseLaneLoader` only re-runs the assignment when 25 or more horses have NO
band at all, and all 100 stranded horses had one.

| band  | before | after   | what the OLD function would have written today |
| ----- | ------ | ------- | ---------------------------------------------- |
| micro | 198    | **200** | 200                                            |
| low   | 521    | **512** | 512                                            |
| mid   | 181    | **288** | 184                                            |
| high  | 100    | **0**   | 104                                            |

`mid` after equals old `mid` + old `high` exactly. The projection folded one
rung into the one below it and moved nothing else: micro and low are identical
to what the unmodified ranking produces on the same data. The 100 stranded
horses are the top 11 percent by bb/100, so they land at the top of `mid`.

## The probe, rolled back first

CLAUDE.md 11.5. One psql transaction, `BEGIN` ... `ROLLBACK`, run before
anything was applied:

- **A** zero horses in a band with no enabled game afterwards. `0 horses
outside {micro,low,mid}`.
- **B** no horse ends above BOTH its merit band and the band it already had. 0. (275 horses already sat above their merit band before the run, held there
  by hysteresis - pre-existing and untouched.)
- **B2** direction of travel: 167 down, 749 unchanged, 84 up. Every one of the
  84 is a merit promotion the unmodified ranking makes on the same data.
- **C** band counts and the bb/100 range inside each band, printed for review.
- **D** idempotent: a second run in the same transaction wrote nothing.
- **E** fail open: with `cash_games.enabled` set false everywhere, the function
  returned no rows and the band counts were byte-identical.
- **F** projection unit cases: high with no high game is mid; high with only
  micro and low is low; micro with only mid open stays micro; an empty
  availability array returns the band unchanged.

## How to verify

```sql
-- no horse in a band with no enabled game
select p.horse_profile->>'stakeBand' as band, count(*)
  from public.profiles p
 where p.is_horse is true
   and not (p.horse_profile->>'stakeBand' = any(public.fn_available_stake_bands()))
 group by 1;                      -- expect zero rows

select public.fn_available_stake_bands();   -- expect {micro,low,mid}

select coalesce(p.horse_profile->>'stakeBand','(null)') as band, count(*)
  from public.profiles p where p.is_horse is true group by 1 order by 1;
```

If Dan re-enables a game above 2/5, nothing needs doing by hand: the next
assignment run reads the floor again, `high` reappears in
`fn_available_stake_bands()`, and the top decile is re-banded into it by merit.

## Tests

`server/src/services/HorseStakeBandProjection.test.ts` covers all 16 shapes the
floor can take: downward only, merit order preserved, idempotent, fails open on
an unread floor, and a band with no game receives no horses from the SQL AND is
skipped by the engine. It also pins the SQL text - availability read from
`cash_games`, the clamp after hysteresis, the absence of any upward search, and
the single-transaction shape.
