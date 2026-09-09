# Realtime Recovery Callbacks Retain Their Registered Owner

A shared Realtime connection can invoke callbacks from another tournament's
async context. An unbound recovery callback then fails the existing authority
check when it calls the intended tournament manager, interrupting recovery and
potentially allowing a synchronous exception to reach the process handler.

GameServer now captures the subscription owner's AsyncResource when registering
bounty notifications, durable manager wakes, compatibility deal-vote signals,
and both channels' status callbacks. Registration requires service startup
context, and reconnect timers inherit the receiver context. Manager methods
continue to establish and enforce their exact tournament and lease generation.
No general context-reset API or exception suppression was introduced.

Verification uses the actual GameServer subscription methods, captured channel
callbacks, and real authority binders. Eight of nine regression cases fail
before the fix; all nine pass afterward. The focused suite passes 28 tests
across callback ownership, data actor context, durable wake protocol, and its
source guard. Direct cross-manager authority exchange remains rejected.
The server TypeScript build passes.

Running-image deployment and a live observation interval remain necessary for
release acceptance. Physical iPad reconnect acceptance remains open.
