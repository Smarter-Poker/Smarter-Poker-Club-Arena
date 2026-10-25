# A raise sounds like a raise, not a call (2026-10-24)

Dan: "A RAISE SHOULD HAVE A DIFFERENT SOUND EFFECT THEN A CALL."

## What was wrong

- `TablePage`'s opponent action echo sent `bet`, `raise` and `call` to the same
  `soundService.playChips()`. Only the hero's own raise reached `playRaise()`,
  so every raise by an opponent or a horse was the call clink.
- `playRaise()` itself was the call clink three times over: the same pitched
  oscillator click swept down to 100Hz. Even the hero's raise read as "the
  chip sound, a bit longer", and its hits were spaced with `setTimeout`, which
  wobbles with the frame rate at a busy table.

## Fix

- The echo now plays `playRaise(actionAmount, bigBlind)` for a bet or a raise,
  scaled by the raise-to amount like the hero's, and keeps `playChips()` for a
  call. This is the split the hand replay already made (`VERB_CUE`: bet and
  raise -> `raise`).
- `playRaise()` is rebuilt from parts the call does not have: a stack pushed
  across the felt (an upward noise sweep), a wooden knock as it lands, a run of
  four to six ringing chips (more for a bigger raise), and a rising two-note
  flick at the end. It stays clear of the all-in, which owns the deep thud.
  Every hit is scheduled on the AudioContext clock.
- The call sound, the check, the fold and the all-in are unchanged.

`tests/unit/raiseSoundsUnlikeCall.test.ts` pins both halves.
