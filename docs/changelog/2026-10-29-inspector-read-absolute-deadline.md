# Inspector reads preserve their absolute deadline

The existing release inspector reader treated an empty three-second selector poll as exhaustion of its absolute budget. The exact original function refused an isolated child that replied after 3.1 seconds at 3.004 seconds despite a six-second supplied budget. The maintained regression now receives that reply, while real overall deadline, output-bound and nonzero-exit refusals remain enforced.

Empty polls now continue against the original absolute deadline, and each ready-list is consumed once. The production eighteen-second budget, three-second polling slice, pipe bounds, fixed commands, ownership checks and cleanup of only the reader's own child remain unchanged.

Twenty-seven existing literal inspector validation boundaries now produce closed refusal codes through the existing remote refusal validator. Unknown errors remain unknown; exception text, stderr, logs, paths and secrets are not exported. The native suite executes 59 tests and its maintained wrapper requires that exact count.

The earlier production refusal's exact causal branch remains unknown. This control-only correction does not claim a successful production read, inspector cleanup, engine activation, live memory qualification or completion of Phase 1.

Fixed command stages distinguish container inspection, health, image identity, probe, history and both final identity/health rechecks. Only reviewed stage/code pairs leave the host; command arguments and output remain private.

The current c857 receiver's pending-state read also refused after approximately 1.4 seconds, independently of the inspector idle-poll bug. Pending reads now distinguish their fixed directory, request read, request binding, unit, journal and final recheck stages. Missing required files have an explicit `records_absent` refusal; they never establish retirement, absence of other work, readiness or permission to retry. The filesystem, immutable request, exact invocation, journal ownership and export checks remain unchanged. The added native regression fails before this change and passes after it, preserving private details and rejecting a changed unit.

The old EED process was independently observed to restart as a new instance before this correction was published. The original failed49b inspector cleanup is ineligible against that different process. This change does not broaden its ownership or reuse old-process capacity evidence.
