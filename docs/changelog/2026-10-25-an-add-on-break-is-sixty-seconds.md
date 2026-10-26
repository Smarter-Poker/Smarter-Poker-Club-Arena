# An Add-On Break Is Sixty Seconds

Owner ruling, October 25, 2026, 18:26 America/Chicago: "ADD ON BREAK SHOULD ONLY
BE 60 SECONDS, UNLESS IT HAPPENS TO BE AT THE SAME TIME AS THE :55 BREAK, THEN
ITS 5 MINUTES, THEY ARE NOT THE SAME BREAK... MAKE THAT ADJUSTMENT AS WELL
PLEASE"

## What happened

Every Midway event with an add-on was spawned with a five-minute add-on break
(withMidwayStructure, 2026-10-20). Sunday Funday Happy Hour (Midway Union) held
all 16 tables from 23:11:24 to 23:16:24 UTC, ten minutes after its :55 break,
and the owner saw it as the tournament freezing again.

## What changed

- Engine (PR #8093): withMidwayStructure spawns `addon_break_minutes = 1`.
- Database (`20261025233013_registered_add_on_breaks_are_sixty_seconds.sql`):
  the registration lock in `fn_guard_managed_game_lifecycle` admits exactly one
  more root change, `addon_break_minutes` to 1 on a pre-start event while
  `app.addon_break_rule` is on; pre-start events that have not opened their
  add-on take 1; schedule configs carrying 5 carry 1. Running events are left
  alone so no live window changes under its clock.

## Still open

When an add-on break overlaps the :55 break, the two pause authorities already
coexist, but the add-on break can still run past the :55 break's end by up to
its own length. With sixty seconds that tail is at most one minute. Ending the
add-on break with the :55 break needs the durable add-on deadline itself to
move, because that deadline closes purchases and finalizes the prize pool; it
is a separate engine change.
