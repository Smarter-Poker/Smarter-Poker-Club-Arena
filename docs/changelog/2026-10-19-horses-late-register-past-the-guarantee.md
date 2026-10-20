# 2026-10-19 - horses keep late-registering after the guarantee is met

Dan: "just because the 'guarantee was met' doesn't mean horses shouldn't still
late register throughout the tournament..."

## What was stopping them

Nothing entered a horse into a RUNNING tournament except the overlay pass in
`server/src/services/HorseOverlayGuard.ts` (`runOverlayGuardOnce`, fed by the
SQL function `fn_overlay_at_risk`). That pass exists to erase an overlay, so it
lists an event only while `ceil(guaranteed_prize / buy_in_amount) >
current_players`, skips any risk whose `shortfall <= 0`, tops up only to the
guarantee's entry count, and only looks at events up to 30 minutes after the
start. Once the guarantee was covered - or 30 minutes had passed - late
registration went silent for the rest of its window. The pre-start ramp hands
off at the start time and the late-ticket path only redeems satellite tickets.

Measured on production 2026-10-20 03:2x UTC, Midway Union and Diamond Arena
MTTs with a late window, previous three days:

- every late entry arrived 0-30 minutes after the start (24 / 157 / 351 by
  ten-minute bucket), then nothing except two satellite qualifiers, although
  late registration runs 25-90 minutes;
- the 46 paid events with no guarantee took zero late entries;
- at 03:32 UTC both "Monday Mystery" events (400 guaranteed, 400 in the pool,
  80 entries, level 3 of a 9-level late window, late registration open) were
  32 minutes in with zero late entries - the last entry was 27 minutes before
  the start - and both "Night Owl Special (NLH)" events (1,500 guaranteed,
  1,512 in the pool, 126 entries, open) were 12 minutes in with zero.

## What changed

`lateRegisterHorsesOnce` joins the guard's two-minute cycle after the overlay
and freeroll passes. For every RUNNING `mtt-v1`/`mtt-v2` event of the host
whose `fn_tournament_late_registration_open` answers true, it asks
`lateRegArrivalsFor` how many horses arrive this cycle: a cumulative curve to a
per-event share of 25-40% of the starting field (minimum two) across the late
window, whichever of the level and clock windows is nearer, at most four per
cycle, with a deterministic -1/0/+1 wobble. Entries that already arrived late
from anybody count toward it. It never reads the guarantee.

Every entry still goes through `topUpWithHorses` and the horse door, so the
maintenance freeze, the fleet hold, lanes (free events use every lane, as the
freeroll filler does), the four-table cap, the horse's wallet, the field cap
and late registration closing all still apply. The overlay pass itself is
unchanged: it still stops at the guarantee, because erasing an overlay is all
it is for.

Engine change only; no SQL migration. Pinned by
`server/src/services/lateRegistrationOutlivesTheGuarantee.law.test.ts`.
