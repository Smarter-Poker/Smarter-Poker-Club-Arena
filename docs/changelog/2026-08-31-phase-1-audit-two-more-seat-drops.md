# Phase 1 audit, part 2 — the other two places a seat could vanish

2026-08-31. After #2068 fixed the loop and the prefetch drop, I grepped every
remaining `seat - 1` / `idx < array.length` site on the table page. Two more
instances of the identical defect, both on DB-driven paths that run BEFORE the
first engine snapshot — which is exactly the window where the client's seat
count is still the guessed default.

## The pattern, for the fourth and fifth time

    const rebuilt = Array(prev.players.length).fill(null);
    for (const seat of seatRows) {
      const idx = seat.seat_number - 1;
      if (idx < 0 || idx >= rebuilt.length) continue;   // <- silently drops
      ...
    }

The array is sized to WHAT THE CLIENT WAS ALREADY DRAWING, then anything that
does not fit is dropped without a word. If the client is drawing six seats
because nothing has told it otherwise yet, seats 7-9 do not exist — hero
included. That is the seat-7 incident, and these two paths could still produce
it independently of the mapper.

1. **The realtime seat merge** (`existingSeats` -> `updatedPlayers`). Rebuilds
   the roster from `table_seats` and is explicitly "the source of truth for
   seated players".
2. **The seat-first roster rebuild** (`seatRows` -> `rebuilt`). Runs on a table
   that has NOT dealt a hand yet, so the guessed width is at its most likely
   to be wrong.

Both now size themselves to the widest seat the DB rows actually contain
(bounded by `MAX_SUPPORTED_SEATS`, so a corrupt `seat_number` cannot make the
client allocate wildly), and both raise `maxPlayers` with it — otherwise the
rows exist in state and render nowhere, which is the same bug wearing a hat.

## Verification

- Full client tree: **689 files, 9,878 tests, 0 failures**.
- `tsc --noEmit` clean.
- Production Build gated by CI (required check).
