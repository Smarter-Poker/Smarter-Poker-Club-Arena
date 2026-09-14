# Inactive original-launch identity component

The host broker derives the connected process from Linux SO_PEERCRED plus SO_PEERPIDFD, then binds its live start ticks, kernel boot, PID namespace, executable, cgroup, current named container, immutable image and release label. The request carries only the protocol version and operation. A caller cannot supply its identity or a broker credential.

A root-owned, bounded, immutable pending-identity record is flushed before a reply. Repeating a request or restarting the broker retains that record; a new process start or host boot produces a distinct identity even when the container/PID/cgroup are reused. Corrupt or inaccessible records are preserved and refused. These local records are explicitly not canonical registrations.

The adjacent runtime client has a bounded, credential-free Unix-socket protocol and waits for actual local socket closure. Its draft bootstrap seam executes for every required engine process boot, including automatic restart, before GameServer construction. The default is inactive. Every enabled attempt currently refuses game-service admission because the Accounting registration-commit port is unavailable; there is no successful session or synthetic acknowledgment path.

The broker is absent from the production installer and engine-up run specification. No socket mount, service activation, host change, release lock change, health-policy change or restart-policy change is part of this candidate. Host mount/installer integration remains dependent on the real canonical commit port and native same-container restart qualification. Do not merge or install this incomplete bootstrap gate into production.

Portable persistence/protocol tests and the TypeScript client tests are component evidence. Real engine-peer authentication, automatic restart, canonical registration/append acknowledgment, request-frontier fencing, cold disposition and funded qualification remain open. An observed process exit or a missing local record never grants no-start, refund, stack or hand-replay authority.
