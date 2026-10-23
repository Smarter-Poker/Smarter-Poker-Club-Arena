# Mobile table energy: remove continuous keepalive and frame clocks

Mobile players reported heat and rapid battery loss while playing at tables.
The table unconditionally started a silent oscillator, an empty three-second
worker ping, and a prewarmed decision worker left over from client horse
thinking. Horse decisions now run on the server. Those continuous resources
are removed. The existing hook only owns bounded insurance-timer cleanup;
workers start for an actual offer and stop when its last decision is delivered
or cancelled. Last-table cleanup also clears ordinary timeout fallbacks.
Actual sound cues, screen wake locks, connections and animations are unchanged.

The action clock previously requested every display frame plus a 500ms
watchdog, although its external store publishes whole seconds. It now schedules
one timeout at the next whole-second boundary, derives each reading from the
server deadline, sleeps at zero, and re-arms for a new turn, reset or extension.
Visibility/pageshow re-evaluates delayed deadlines immediately. Active-turn and
fired-once guards remain. The CSS ring and its animation duration are unchanged.

Regression tests failed before repair: table mount allocated silent audio;
fractional-second transition waited for a driver rather than its boundary;
completed/cancelled decisions retained workers and fallback timers. Tests now
cover four-table churn, expiry once, pending decisions surviving another table
leaving, cancellation, fallback/unmount cleanup, reset/extension, next turn,
delayed resume and page/leaf render isolation. The historical test's demand for
a RAF request is replaced by the no-frame contract, retaining its timeout
assertions. All source was re-read after editing. TypeScript and final check
results are recorded in CHECKPOINT-mobile-table-energy.md.

Controlled production-React Chromium fixture with four actual hook instances,
16 seconds: before 4,396 frame callbacks and 128 interval callbacks, one silent
AudioContext, two workers and five empty messages; after 64 deadline callbacks,
zero frames/intervals/audio/workers/empty messages. Both versions ended at zero
and expired exactly once per table. This isolates these hooks; it is not a
full-table CPU profile or a physical iPhone temperature/battery measurement.
Retained evidence: /Volumes/SmarterArchives/agent-evidence/mobile-table-energy-01a16a0d.

Client-only existing APIs, no new engine contract, migration or restart.
Real-time law: existing turn_change/insurance_offers events establish the
server deadlines; no network polling or snapshot-diff trigger is added.
