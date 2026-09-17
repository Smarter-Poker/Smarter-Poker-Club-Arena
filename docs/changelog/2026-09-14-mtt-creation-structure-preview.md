# MTT creation previews the exact proposed structure

The manual form selected a Standard blind-growth preset alongside an independent
three-minute level clock and 1,000 chips. That produces a 50-BB Turbo event;
selecting Slow alone leaves the clock at three minutes. The form did not explain
this before the owner created or saved the event.

The form now renders an MTT structure preview from the same buildTournamentConfig
payload used by Save and Start and the shared engine structure description. It
shows actual speed, level minutes and starting depth together, and explains the
separate growth and clock controls. New control values update the preview on
render; no new timer, request, registration or creation call is introduced.
Satellites use the same preview. Non-MTT modes do not advertise MTT facts.
Malformed restored stacks remain unconfirmed, and a restored zero-minute draft
shows the one-minute clock the existing mapper actually emits.

Validation: 53 client cases across the preview, real creator mapper and existing
seat-law suite pass; app TypeScript passes. Eight preview cases include live prop
changes, an unchanged frozen input, Standard/Slow overrides, satellite, non-MTT
and malformed-stack cases. This is component/source evidence, not full browser,
protected CI or served adoption. Existing defaults and booked terms are unchanged.
