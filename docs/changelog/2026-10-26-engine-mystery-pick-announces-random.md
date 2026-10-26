# 2026-10-26 - Engine: a horse always taps; a server-drawn pick is announced as random

Follow-up to #8150, from the server audit of the five-second mystery pick.

- A horse's tap now always records its pick, a single chest included. With
  20261026045104 an engine pick opens the award as a person's tap does, so the
  last knockouts of an event (too few chests left for companions) no longer
  open on every seat with a 0 and the figure arriving at the deadline.
- When the engine draws the slot for a revealer whose screen never answered,
  it announces it on `mystery-chest-<tableId>` with `auto: true`, the same
  shape a browser's timeout sends, so every seat reads "Time Ran Out - Chest N
  Was Picked At Random" instead of "<Name> Picked Chest N".
- A refused pick is reported instead of ignored.
- Comments brought up to the 14.3 s hold and the five-second window.

Activates in the daily 04:00 America/Chicago engine update.
