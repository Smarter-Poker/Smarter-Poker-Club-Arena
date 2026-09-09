# A resumed table must prove its open socket still works

## Reproduced failure

On browser `online`, EngineStateClient returned immediately if the socket
still reported OPEN. On `pageshow` or visibility return it requested state,
but used the ordinary 35-second soft / 60-second hard watchdog to detect a
missing answer. A mobile TCP connection can remain half-open across a network
change while those properties remain unchanged. That recovery can consume
most or all of the player's 30-second reconnect allowance before replacing
the dead transport.

Seven new behavior tests failed on the previous code: the two OPEN socket
modes ignored online or did not replace the dead connection inside the wake
budget, and repeated wakes/PINGs did not promptly resolve missing state.

## Change

A foreground return or network-return event sends an authoritative RESYNC and
starts one five-second response budget. Only an accepted full snapshot clears
that probe; equal sequence is a valid idle-table response. PINGs and repeated
wake events cannot extend its deadline. A hidden page, disconnected client,
replaced socket or announced engine restart cannot be torn down by an old
probe callback.

On timeout the authenticated reconnect path starts again. For multiplexed
tables, silence since the probe replaces the physical socket immediately.
Creating another facade on the same half-open socket would otherwise add a
15-second SUBSCRIBE timeout. If other traffic proves that shared socket is
responsive, only the missing table subscription is replaced. An old facade
cannot close its successor's transport.

This is the shared table transport for cash, MTT, Spin and Sit & Go. Player
protection remains 30 seconds for non-VIP/expired VIP and 45 seconds for active
or lifetime VIP; the client cannot grant or extend that server allowance.
No player action or purchase is automatically replayed by the probe.

MDN references reviewed:

- https://developer.mozilla.org/en-US/docs/Web/API/Window/online_event
- https://developer.mozilla.org/en-US/docs/Web/API/Window/pageshow_event

## Verification and acceptance

The real client and mux classes run against deterministic WebSockets in the
existing recovery suites. Coverage includes both transport modes and all
three resume events, unchanged snapshots, PING-only traffic, repeated wake,
hidden pages, disposal, scheduled restart and stale-facade isolation.

At this checkpoint the change is local. Physical iPad Home Screen and live
network-switch verification are still outstanding; passing a simulated
transport test does not establish that those device flows are fixed.

Local verification completed: 95 tests passed across the client-recovery and
multiplexed-socket suites, including 12 new cases. Root `tsc --noEmit` passed.
No existing test was disabled. The old wake-grace test now supplies its
healthy snapshot at four seconds, inside the explicit five-second budget.
