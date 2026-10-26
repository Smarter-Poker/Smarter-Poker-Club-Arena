# 2026-10-26 - Engine: the mystery pick deadline follows the five-second rule

Dan 2026-10-25: "THEY HAVE 5 SECONDS TO PICK THERE BOX, AND IF THEY DON'T
RANDOMLY CHOOSE IT."

The client half (PR #8147) gives five real seconds and picks at random on the
revealer's own screen. This is the engine half, for a revealer whose screen
never answers:

- `CHEST_AUTO_OPEN_MS` is now `CHEST_PICK_WINDOW_MS` (5000) + 1500 ms for a
  last-second pick to land (was 9000). The reveal deadline and the table hold
  shrink with it, so the table moves on ~2.5 s sooner after every chest.
- At the deadline, if nobody picked, the engine records a uniformly random
  slot (`node:crypto`) through `fn_mystery_bounty_pick` before it reveals, so
  the prize stands in a real chest and the other two are shown beside it.
- A horse's tap waits 1.5-5.0 s, inside the same five-second window a person
  has (CLAUDE.md 10.5).

Activates in the daily 04:00 America/Chicago engine update.
