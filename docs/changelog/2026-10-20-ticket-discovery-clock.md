# Ticket discovery qualification uses its own clock

Engine release 39442726703 failed the zero-quota prestart ticket assertion while the same test and exact server shard passed locally. The fixture scheduled its event ten minutes after the wall clock. Around 14:51 UTC, the break-adjacent preparation rule correctly moved that event into launch admission, so registration top-up was no longer its expected path.

Replaying the fixture at 2026-10-20 14:51 UTC reproduced the same missing-call failure. Ticket-ramp cases now use a fixed 12:10 UTC clock, outside break-adjacent preparation. An explicit 14:51 case verifies that the event is offered to launch admission with no registration top-up. The original ticket assertions remain intact; production preparation and maintenance behavior are unchanged.

The regression failed before the correction, then all 11 ticket-discovery cases and server TypeScript compilation passed. This is test-only source; it introduces no runtime engine contract or activation requirement by itself.
