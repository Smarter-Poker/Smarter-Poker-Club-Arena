# Only highlighted tournaments may use ten-minute levels

The Deep Stack name used to select ten-minute levels for every event. The actual is_pinned/highlighted flag now controls the exception: other scheduled MTTs and satellites cap at eight, while turbo and freeroll five-minute clocks stay faster. Existing Spin and SNG clocks remain five minutes or less; oversized custom short-format levels are capped too, without slowing faster levels.

The source creator and installed database trigger apply the same cap. The migration updates already-scheduled, not-yet-started tournaments and explicit schedule ladders, retaining blind amounts, faster clocks, payouts and existing highlighted ten-minute structures. Derived late-entry minutes follow the new clock. Running tournaments retain their currently advertised clock rather than changing mid-level.

Native PostgreSQL qualification reproduces the old ten-minute ordinary event, applies the exact migration, and verifies existing/future rows, highlighted exception, turbo preservation, derived late-entry minutes, active-event preservation and drift refusal. It runs in required accounting CI.
