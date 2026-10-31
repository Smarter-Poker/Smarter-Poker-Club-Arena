# Original lease incident historical metrics

The manual scoped runtime reader can request `leaseHistoricalMetricsOnly: true`
together with `leaseIncidentMetrics: true` and an explicit completed original
15-minute interval up to seven days old. Admission is identical at the GitHub
dispatch and pinned host entry. This exclusive mode does not capture or parse
Docker logs, archives or restart evidence. Ordinary mixed observations retain
the existing 48-hour log limit.

The fixed localhost query, twelve metric names, enum labels, 15-second step,
61-sample/64-series/256-KiB bounds, five-second request timeout, no redirects,
identity bracket and finite SSH budget remain unchanged. Historical retention
is not guaranteed: configured Prometheus retention is seven days or 1 GB.
Missing, partial and unavailable evidence remains unknown, and observation-time
engine identity does not establish historical series provenance or cause.

This diagnostic delivery requires protected merge and an actual manual read;
it changes no engine, monitoring configuration, production data or schedule.
Focused regressions run through the existing scoped runtime reader fixture and
its maintained TypeScript enforcement.

## Change 1: admit only bounded historical metrics

**File:** `scripts/ci/read-scoped-runtime-errors.py`
**Lines before:** 98–116 and 1016–1138.
**What existed:** `log_window` rejected every interval older than 48 hours,
including the optional lease metrics read. Both entry points then captured
Docker logs and archives before requesting metrics.
**What changed:** shared admission accepts the exclusive four-field historical
metrics opt-in for one completed 15-minute interval within seven days. That
branch requests only the existing fixed metrics query and records that logs
were not requested; ordinary log admission remains 48 hours.
**Why:** the original October 27 09:05–09:20 incident window is within configured
metric retention but outside log admission. Historical availability and cause
remain unproven until an actual read.
**Verified:** YES, reread the final diff and connected dispatch/remote flow.
**TypeScript:** PASS, `./node_modules/.bin/tsc --noEmit`, exit 0.

## Change 2: preserve refusal and transport regression coverage

**File:** `tests/fixtures/scoped-runtime-errors/native-fixture.py`
**Lines before:** lease cases 230–351; dispatch transport fixture 1067–1142.
**What existed:** opt-in, sanitization, transport and ordinary log-age cases.
**What changed:** added historical admission boundaries and both-entry refusal
cases, no-log execution assertions, and forwarding/result mismatch cases in the
existing transport fixture. Existing ordinary cases remain enforced.
**Why:** historical admission must never widen Docker reads or accept a mixed,
incomplete, malformed or unrequested observation.
**Verified:** YES; two added regressions failed before implementation. Final
existing native fixture: 58 PASS; maintained `tests/scopedRuntimeErrors.test.ts`:
5 PASS, including that native fixture. Source bindings: 1814 pins PASS.
**TypeScript:** PASS on the same candidate; no TypeScript source changed.
