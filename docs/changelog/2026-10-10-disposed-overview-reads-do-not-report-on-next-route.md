# Disposed Overview Reads Do Not Report On The Next Route

The production cashier zero-console case in run 38061965075 failed when an
overview RPC aborted during navigation. Its diagnostic recorded ERR_ABORTED
alongside page chunks and telemetry, without an HTTP failure. The overview hook
already discarded superseded reads, but its effect cleanup left an outstanding
read eligible to report an error and update disposed state.

The original cleanup now invalidates that reader's outstanding request. Active
read failures still report the same error and show unavailable readings. No RPC,
cache, finance assertion, permission or engine behavior changes.

Mounted React regressions reproduce two failures before the correction and pass
afterward, including navigation/unmount and former-club outcomes. The active
transport-failure regression passes before and after. The maintained client CI
discovers the new unit test through its existing tests/\*_/_.test.ts selection.
The lifecycle and existing overview contract group passes 57/57. Publication and
affected production browser proof remain pending for this follow-up.
