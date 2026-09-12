# The financial runner owns its test players' lifetime

A new observer-side runner connects the existing eight financial checkpoints
to the two ordinary authenticated actor clients and their own state samples.
It verifies engine identity before starting the actors, retains one deadline
for the entire attempt and stops both actors on completion or failure. Late
startup handles are closed. No retry or replacement attempt is started.

The existing actor client now accepts an abort signal. Aborting interrupts
startup, stops queued actions, aborts its HTTP requests and closes both sockets.
The runner receives ordinary disposable user sessions and the caller-owned
fixed observation client; it creates no database authority or money writer.

The combined financial suite passes 112 checks with zero skips. These include
six runner lifecycle checks and three real loopback socket cancellation checks.
The fixture's outer native coordinator still needs to invoke this runner in the
independent observer process and supply the canonical financial scenario. Full
consumed schema/ACL qualification, felt reconciliation, genuine funded gameplay
and canonical cleanup remain required. Source and protocol tests grant no
product certificate or production activation.
