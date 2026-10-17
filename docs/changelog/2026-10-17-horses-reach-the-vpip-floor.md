# Horses reach the VPIP floor (2026-10-17)

## What was wrong

On the private Lightning pilot's six-seat NLH Madness (VPIP floor 50, judged
over ten hands, two-hour bar on eviction), 17 of 18 horse sittings ended
`vpip_evicted`. The game sat at 3 to 6 seated and could not reach the 18
players a Lightning pool needs. Of the 72 pilot horses, 62 had already used
their daily sittings.

The floor and the bar are the owner's and stay exactly as they are. The
defect was in the horse's play: `vpipFloorMul` widens the range a horse opens
and continues with, and that alone cannot reach 50. Measured offline on the
real preflop brain over all-horse tables, judged every hand from the tenth as
`fn_nit_check` does:

| floor | seats | VPIP before | evicted before | VPIP after | evicted after |
| ----- | ----- | ----------- | -------------- | ---------- | ------------- |
| 0     | 6     | 21.6%       | -              | 21.6%      | -             |
| 0     | 9     | 16.3%       | -              | 16.3%      | -             |
| 30    | 6     | ~40%        | ~15%           | 45.7%      | 0%            |
| 30    | 9     | ~39%        | ~15%           | 45.2%      | 0%            |
| 50    | 6     | ~38%        | 100%           | 64.6%      | 0%            |
| 50    | 9     | ~34%        | 100%           | 64.3%      | 0%            |

The widening clamp fired on only 893 of 488,325 floored decisions in
production telemetry, so the clamp was not the limit. The limit was the cheap
fold: a horse under its floor still folded to a limp or a small raise, and
every such hand counts against it.

## The fix

`vpipFloorCallDown` in `server/src/engine/HorseLogic.ts`, run inside the
`reference` policy node right after the preflop decision. Preflop, on a
floored table, a horse below its target (`vpipTargetFor`) that is about to
fold for a price of at most 6 big blinds and at most 15% of its stack calls
instead, with probability `min(1, 10 x gap)`. A horse at or over its target,
a larger price, a check, a bet or a raise are returned untouched. Tables with
no floor are unaffected (the floor-0 rows above are identical).

It lives inside the reference node so the policy graph's predecessor chain is
unchanged: an out-of-graph change after the chain throws, and the brain falls
back to a fold, which is why a first attempt placed at the end of the
decision had no effect.

Telemetry: `vpip_floor_call_down` counts each converted fold.

## Tests

`server/src/engine/HorseVpipFloorCallDown.test.ts` pins the rule: when it
calls, what it pays, and every case it must leave alone.

Ships through the normal staged engine release and the hourly break.
