# Diamond Plinko, Diamond Crash, and the wheel's three open items

**2026-09-08. Dan, on the three items the wheel changelog had filed as his:
"NOTHING IS MINE, THESE ARE ALL 100% YOURS." And: "ALSO WANT TO HAVE TWO
ALTERNATES TO THE DIAMOND TO CHIP SPINNING WHEEL. 1ST, A PLINKO VERSION, 50X
CAN BE HIGHER ON THIS, BUT CRASH OUT PAYS NOTHING, AND YOU STILL NEED TO
MAINTAIN THE 20% EDGE. 2ND, A CRASH / AVIATOR-STYLE: MULTIPLIER CLIMBS UNTIL
IT CRASHES; CASH OUT FIRST. 50X CAN BE HIGHER, CRASH OUT PAYS NOTHING, AND YOU
STILL NEED TO MAINTAIN THE 20% EDGE." Later the same session: "ALL YOUR BUILDS
NEED TO FOLLOW THE #SMARTERCASINOREALISM AND ALL THE BUTTONS, FRAMES, ICONS ETC
NEED THE PREMIUM, HIGH DEF, DYNAMIC LOOK AND FEEL AS THEY ARE INSIDE THE REST
OF THE CLUB ARENA PAGES."**

Continues `docs/changelog/2026-09-07-diamond-wheel.md`.

## The three decisions, taken (`20260908004858`)

1. **The cold float.** The wheel's diamond tiers were paid from a float that
   accrued 5.7 diamonds a spin, so a new host opened with the 250-diamond tier
   locked for its first ~43 spins and re-locked after every hit. The chip side
   never had that problem because the host accepts a 500-chip exposure
   allowance up front; the diamond side now gets the same shape: a
   `diamond_seed` (2,500 diamonds, 25 chips of value) the pool's float starts
   at. The invariant is unchanged in form (`diamond_float >= 0`) and the value
   bound is `paid <= 0.80 x intake + exposure_allowance + diamond_seed / rate`,
   the plan's "seed float" on both currencies. The seed is a memo cap: diamond
   prizes are promotional issuance under the engine budget either way. It is
   editable from the console; lowering it never drives the float negative.
   `fn_wheel_metrics` nets it out of the house take.
2. **The hosts are open.** Two hosts exist: the Midway Union (3 clubs, 1,508
   members) and Deep Stack Society (standalone, 418 members). Both got a
   `wheel_configs` row at the plan's settings, enabled. `purchased_only` stays
   true: 2 purchased lots exist against 1,023,512 diamonds of supply, and
   Dan's 2026-09-05 ruling that nothing ever earns chips means promotional
   diamonds do not become chips here. The operator can widen it; the default
   is the closed one.
3. **The closed-loop exception.** Written into
   `docs/DIAMOND-ACCOUNTING-STANDARD.md` (DR16 and section 6 item 7) naming
   the three Diamond Games, their rules, and where the exception stops.

## Plinko and Crash (`20260908010225`, `20260908010241`)

Both stand on the wheel's foundation and share one money shape with it: a
round is paid for in diamonds through `deduct_diamonds` (purchased lots only
by default); 80 percent of the intake is minted, in chips, to the host bank
through the issuance door, declared `mint` from `issuance_reserve` and
registered by the chip_ledger trigger (a bet is whole chips, so the mint is
exact cents and needs no carry); 20 percent is retired diamonds, the house; a
payout comes only from the host bank and only inside
`chips_paid + payout <= chips_minted + exposure_allowance`, so cumulative
chips paid `<= 0.80 x intake + allowance` by arithmetic, whatever the RNG does.

Where the wheel LOCKS a tier it cannot afford, these two CAP the multiplier:
before a round the pool computes the largest multiplier it can promise on that
bet - `cap_fraction` (0.95) of its headroom (minted + this mint + allowance -
paid - reserved), never above the ceiling, never above the host bank beyond
open reservations - and the round is played against `min(table, cap)`. The cap
is shown before the bet. **The 0.95 is what keeps the pool alive**: a cap of
100 percent could leave a pool exactly at its ceiling with nothing playable
and no intake to rebuild it, a deadlock seen in simulation before this was
written; with 0.95 a full-cap hit leaves five percent of the headroom plus the
round's own mint, so the next round always has a cap above 1.00.

### Plinko

16 rows, 17 slots, slot k at C(16,k)/65536. The ball's path is the first
sixteen bits of the round's HMAC (Postgres `get_bit` order), one per row,
right when the bit is one; the slot is the number of rights. Three tables,
each auditing to EXACTLY 0.800000 on the binomial weights
(`sum C(16,k) x m_k = 5,242,880` cents-weight), the centre paying nothing on
every one:

| table    | from the edge inwards                      | edge odds   | sd   | balls that pay |
| -------- | ------------------------------------------ | ----------- | ---- | -------------- |
| Steady   | 20x 10x 5x 2.5x 1.6x 1.3x 1x 0.65x 0       | 1 in 32,768 | 0.62 | 80.4%          |
| Bold     | 130x 40x 9.95x 4.1x 2x 1.05x 1x 0.5x 0     | 1 in 32,768 | 1.42 | 80.4%          |
| Moonshot | 1000x 100.5x 20.25x 5.25x 2.5x 1.3x 1x 0 0 | 1 in 32,768 | 6.13 | 45.5%          |

`fn_plinko_table_audit` derives the return from the weights;
`fn_plinko_activate_table` refuses any table that is not 0.800000, and
`fn_diamond_game_set_config` refuses to enable a host without one. The
non-round figures (9.95, 20.25, 100.5) are what exactness costs: the
Diophantine solve over integer cents lands there.

### Crash

The crash point is `X = floor(80 x 2^48 / (r + 1))` cents on the 48-bit roll,
floored at 1.00. For any target x, `P(X >= x) = 0.8 / x` exactly to the 48-bit
grain, so cashing out at ANY target returns 80 percent in expectation,
including 1.01x and including the cap. About 20.8 percent of rounds crash
instantly. The multiplier climbs as `e^(0.12 t)` on the server's clock from
the row's `started_at`; the client only draws it and asks `fn_crash_settle`
what the round is. A cash-out settles at the multiplier the server's clock
reads when the call is processed, never at what the screen showed. An auto
cash-out target is honoured by the server the moment the curve passes it,
whatever the connection does. The largest payout an open round can produce
(bet x cap) is reserved in the pool until it settles, so two open rounds are
never promised the same headroom or the same bank.

A round nobody touches is settled by time: once the curve is past the cap the
outcome is already decided (cashed at the auto target, cashed at the cap if it
never crashed, or crashed), and the next call on that host settles it
(`fn_crash_settle_decided`, run on the way into every money path). That is the
live path finishing its own work, not a sweep (CLAUDE.md 10.12); no cron
exists.

### The probe (rolled back, CLAUDE.md 11.5)

One `DO` block ending in `RAISE EXCEPTION`, as vinniecards in Club JAQK on the
Midway Union: state before and after; a plain member cannot configure; a
150-diamond bet option and a 150-diamond bet are refused; a crash ticket
cannot drop a plinko ball; 30 drops across the three tables (the revealed seed
hashes to the commitment, the path recomputes from the HMAC, a second call on
the same commit replays); four crash rounds with a fast curve (k = 5): auto
target settled by time on the way into `fn_diamond_game_state`, manual cash-out
at once, a tick past the cap, an auto target above the cap refused, a second
start resuming the open round; reservation 1,000 chips while open and 0
after. Then the arithmetic: diamonds moved = intake; union bank moved = minted

- paid; member wallet moved = paid; 34 mint legs, 24 prize legs, 34 journal
  rows, 0 suspense; both metrics invariants hold. Production untouched.

### The front end, in #SmarterCasinoRealism

`src/components/diamond-games/CasinoChassis.tsx` wraps the approved
shark-panel-v1 artwork the lobby's game panel already ships (the riveted
gunmetal rails with their blue lamps, the bay plaque, the lit JOIN face and
the dark VIEW face) as `CasinoFrame`, `CasinoBay`, `CasinoButton`,
`CasinoChips` (the lobby's filter row), `CasinoReadout` and `CasinoWell`. The
three game pages, their lobby and the operator console draw from it; no page
invents a frame. `DiamondWheelPage` is rebuilt on it (same logic, same RPCs).

- `/clubs/:clubId/diamond-games`: the lobby, three tiles, each reading its
  own state. The Promotions banner leads here.
- `/clubs/:clubId/plinko`: the board (Canvas, chrome pegs lighting as the
  ball passes, slots graded by multiplier, gold where the cap trimmed them),
  table and bet pickers, the odds per slot ON THIS BET, fairness, history.
- `/clubs/:clubId/crash`: the curve (Canvas, server-synced clock), the live
  readout, bet, auto cash-out stepper and presets with their reach chance,
  START and CASH OUT, the odds table (reach chance and time for each target),
  fairness, history. A refresh resumes an open round.
- `/clubs/:clubId/diamond-games-operations` (finance rail, "Diamond Games"):
  one console, a game switch, the readings, the per-window z table, the
  controls, the pool. The wheel console gains the diamond seed.

`src/utils/diamondGamesFairness.ts` recomputes both games in the browser;
`tests/unit/diamondGamesFairness.test.ts` pins it to Postgres vectors.
`tests/the-games-never-pay-more-than-they-take-in.law.test.ts` pins the
migration.

### Not built, on purpose

- A shared multiplayer crash room. Each player rides their own round; the
  pool and the bank are shared, the curve is not. A room is a broadcast
  problem the single-player design does not need to solve to be fair.
- Sound cues. None of the three games has one yet; when one is added it
  falls under 10.6 like every other.
