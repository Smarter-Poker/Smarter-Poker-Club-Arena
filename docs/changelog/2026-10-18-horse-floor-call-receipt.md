# The reference receipt accepts the floor call-down

A floor-50 cash horse with a 10 BB chart fold correctly chose a cheap call
through the owner-approved VPIP-floor call-down. The Phase 6 reference receipt
validator still allowed only the chart's literal jam/check/fold outputs, so
the live client failed the worker with reference_shape. Production logged that
error as an uncaught exception and entered a fatal shutdown (13:43:51Z);
Docker reported 54 restarts during recovery.

The reference-shape validator now recognizes the exact call the existing
call-down owner permits. A deterministic zero callback tests positive
probability without consuming RNG or repeating the original chart decision.
Source-route, snapshot and graph binding remain enforced. Calls without a
floor, above target, beyond the stack cap, on all-in-or-fold tables, or for
the wrong amount remain refused. The decision strategy is unchanged.

Two real-decision/client regressions failed before and pass after. The
resumption evidence and exact release state live in the existing round-4
handoff, section 8. All packs remain shadow pending the current-policy
strength and fresh completion evidence.
