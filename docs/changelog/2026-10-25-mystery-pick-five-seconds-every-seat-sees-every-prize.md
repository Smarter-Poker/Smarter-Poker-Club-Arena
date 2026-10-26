# 2026-10-25 - Mystery Bounty pick: five seconds, random if no pick, every prize shown, never zero

Dan, watching 5K GTD Sunday Funday Mystery (Kings Club / Midway Union):

- "THE PLAYER WHO WON SAYS THEY NEVER CLICKED ANYTHING, IT JUST AUTO PICKED THE
  FIRST ONE AND ONLY SHOWED THE FIRST PRIZE. IT DIDN'T SHOW THE OTHER TWO BOXES
  EITHER. THEY HAVE 5 SECONDS TO PICK THERE BOX, AND IF THEY DON'T RANDOMLY
  CHOOSE IT. AND YOU MUST ALWAYS SHOW THE OTHER 2 PRIZES THAT 'COULD OF BEEN
  CHOOSEN'."
- "I JUST WATCHED THE LAST TWO PLAYERS GET ZERO APPEAR ON THE SCREEN INSTEAD OF
  THE PRIZE THEY GOT" / "LAST 3 PLAYERS NOW! IT SOMETIMES FLASHES IT VERY LATE."
- "THE 3 BOXES NEED TO BE CENTERED ON THE SCREEN."

## What the rows showed

Burls (the only human revealer, award bbeafa64, 04:36:42 UTC) never picked:
`picked_slot` null, revealed by the engine's deadline 11.4 s after the reserve.
Every horse pick left `revealed_at` 9.7-11.4 s after the reserve: the award
stayed sealed long after the horse's tap had opened the chest on every screen.
Dan's screenshot: sleepyreg picked chest 1 (80), every watching seat showed 0.

## Causes and fixes

1. Nine-second window, no pick on timeout. Now `PICK_WINDOW_MS = 5000`, real
   seconds, visible countdown; on timeout the revealer's client draws a slot
   with the CSPRNG and records it through `fn_mystery_bounty_pick`; every seat
   says "Time Ran Out - Chest N Was Picked At Random".
2. The three chests disappeared on open. The row now stays for the whole
   sequence; on the reveal each chest carries a plate ("Your Prize" / "The
   Prize" and two "Could Have Been"). TablePage reads the offer (bounded, 20
   tries, one chest) until every chest is described.
3. Off centre: a 420 px row inside a 340 px stage. The stage widens to the row.
4. Zero on screen. The reveal waits for the amount; a non-revealing seat takes
   the prize from the revealed offer; `mystery_bounty_complete` keeps the
   amount of the chest on screen; a horse's pick opens its award in the same
   statement (migration 20261026045104), as a person's browser does
   (CLAUDE.md 10.5). Nothing moves money: payment stays the engine's settle.
5. A table-wide "chest opened" boolean could open the next chest early. It is
   keyed by award, and the server's reveal opens every seat.

Pinned by `tests/the-mystery-pick-is-five-seconds-and-every-seat-sees-every-prize.law.test.ts`
and `tests/components/MysteryBountyChestPickOneOfThree.test.tsx`.
