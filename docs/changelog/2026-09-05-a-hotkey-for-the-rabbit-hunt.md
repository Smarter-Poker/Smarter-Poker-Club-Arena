# A hotkey for the Rabbit Hunt

2026-09-05. P4 of the card presentation programme.

## Why

The 2026-09-05 competitive research into rabbit hunting across GGPoker, WPT
Global, ClubWPT Gold, Winamax, PokerStars, partypoker, PokerBros, ClubGG,
PPPoker, X-Poker and EvenBet found exactly one room with a published answer
to the problem a multi-tabler has with a short inter-hand window: GGPoker
maps a Rabbit Hunt hotkey. Our window is now 2250-2650ms visible (the 1750ms
rest shipped in #3152); a player watching four tables still has to find the
tile with the mouse. A key does not need finding.

## What

**B** runs the Rabbit Hunt while an offer is up.

- `useTableKeyboard` gains `onRabbitHunt`, under the toggle keys: active
  table only (`isActive`, the multi-table rule that file exists for), never
  for a spectator, never under a modal, never with Cmd/Ctrl/Alt (those belong
  to the browser), never while typing in a field. It is the ONLY keyboard
  system on the table and this is the only place B is bound.
- `RabbitHunt` accepts `registerHotkey`. While the tile is mounted with an
  offer up and nothing yet revealed, it hands the page its own `handleReveal` -
  the same single-flight mutex, the same one-call charge, the same toasts a
  tap gets - and nulls it the moment the offer is gone, the reveal has
  happened, or the tile unmounts. So B on a table with nothing to hunt reaches
  no code at all, and there is no second reveal path to drift from the first.
  The button carries `aria-keyshortcuts="b"` and says "(B)" in its title.
- TablePage owns the ref, makes the assignment itself (so
  `bustHoldIsWired.test.ts`, which guards that every callable ref on the page
  is assigned on the page, still holds) and wires `onRabbitHunt: () =>
rabbitHotkeyRef.current?.()`.

The `rabbit_hunt_button` setting still hides the tile; with the tile hidden
there is no handler in the ref, so the key is off with it. One switch, one
meaning.

## Not done

A user-mappable key. GGPoker's is mappable; ours is B. Mapping needs a
settings surface for keys that does not exist yet, and every other key on the
table is fixed too. If Dan wants mapping it is one setting away, not a design.

## Verification

`tests/unit/rabbitHuntHotkey.test.tsx`: the hook (fires, inactive table,
spectator, modal, modifiers, no handler), the tile (registers while up,
withdraws after the reveal and when the offer is gone, aria-keyshortcuts),
and the page wiring with a pin that no second keydown listener returns.
tsc clean; the rabbit and keyboard suites green.
