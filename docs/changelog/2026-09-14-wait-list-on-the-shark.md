# The wait list, on the shark

2026-09-14. Branch `feat/riveted-spins-banner-families`. The first surface of
the felt sweep, and the pattern for the rest.

`WaitListModal` was a generic blue-grey rounded card with a red-outlined
button: 24 on the standard's scanner, no master art, its own colour scheme.
It is now the shark family: the diamond crest, the header well with the
table name as the eyebrow and the position as a gold pill, the position,
estimate and blinds as rows on the glass (label in lit blue, value in silver,
an engraved rule between), the queue as rows below them, and the one action on
the painted plate.

## One plate, three states

The shark foot paints one plate, so the action changes with the step instead
of a second plate appearing: Close when the player is not in line, Leave Wait
List when they are, and Leave in red ink once they have said they mean it.
Cancel is the lit word on the glass beside the question - the control Club
Rules uses for its second action. The header's close glyph is gone; Close is a
lit word under the queue, and the scrim still closes on tap.

## Re-rendered, not rewritten

Every prop is the same. Preserved and re-tested: the confirm step and its reset
on close (the stale-confirm trap), the stagger timers and their cleanup, the
one-minute tick, `myPosition` and the estimate that prints only when a caller
supplies a real average, `handleLeave`, the haptic on Leave, `autoFocus` on
Cancel, the avatar fallback, the scrim's `onClick` and the dialog's
`stopPropagation`. Pinned strings kept: `#2`, `Est. Wait`, `No Players
Waiting`, ` (You)`. `finalSweep20260908` passes unchanged.

## Verification

Rendered at 393px in four states - in line, the confirm step, not in line,
empty queue - beside the old component in the same states. Every plate label
sits well inside its face. Copy gates and no-emoji OK; tests in the log.
