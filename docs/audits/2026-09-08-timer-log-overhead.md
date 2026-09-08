# Routine Timer Logging

A read-only production container log count measured 855 `Timer event` lines in a ten-second window on September 8. The Base engine attached an observer whose sole effect was formatting and logging every start, cancellation, expiry, extension, pause and resume.

Remove that observer. PreciseActionTimer still registers and fires deadlines, invokes the separate onExpiry callback, and reports callback failures through reportError. Time-bank accounting, disconnect events, validation and integrity warnings are untouched. This removes a measured source of unnecessary console work; it does not quantify a hand-gap reduction or resolve the entire latency issue.

Other release work: PR 3637 bounds database response-body stalls; PR 3640 measures settlement steps. Both merged but were not included in engine 3f26d693 at the 02:55 cutover. PR 3641 integrates next-hand overlap and Rabbit display ownership; this session resolved its conflict with 3640 and pushed 887caa0e to the existing PR. Live completion-to-deal and browser-visible timing still need verification.

Maintenance audit remains open: the production fn_thaw_platform inspected September 8 does not mention engine_presence_parked, graceDeadlineMs or reconnectDeadlineMs. The loader returns stored state unchanged and restoreFsmStates restores absolute deadlines. A complete correction must shift persisted state and already-loaded memory once per freeze, preserve remaining allowance, avoid reviving expired grants and avoid double shifts on retries or restart. The full current maintenance handoff (1331 lines) and restart programme were read before this Base change.
