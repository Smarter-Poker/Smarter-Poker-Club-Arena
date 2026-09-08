# Settlement retries must not hide a frozen table

The Madness NLH 2/5 incident exposed a separate observability defect. The
engine was waiting in `await_post_hand_tasks+1061s`, but settlement retries
and 15-second wait slices called `markProgress()`. `/health.stalledTables`
was empty. That clock proves the process is executing, not that a hand can
finish. The resolved-add-on replay defect behind the incident was repaired
in #3845; this change prevents its retrying shape from disappearing from
health telemetry again.

## Change and wiring

`ServerTableEngineBase.trackSettlementInFlight` now preserves the start of a
continuous settlement across barrier extensions. Its existing identity-checked
completion handler still owns when the promise is finished. `settlementAgeMs`
returns null after completion, starts fresh for a new hand and is independent
of retry heartbeats. `GameServer.tableLivenessSnapshot` publishes that clock.

`GameServer.getStatus` consumes `settlementHealthSnapshot`: a 30-second owned
settlement is explicitly `settlementStatus: blocked`, with a total count and
the oldest 20 table IDs, hand counts and ages. `getPrometheusMetrics` consumes
`settlementPrometheusLines` for a fleet count and per-table continuous age.
This diagnostic boundary is not a new next-hand delay allowance.

The signal does not release the authoritative financial barrier, remove a
route, change HTTP readiness or trigger a fleet restart. Settlement still must
complete before the next deal. Old comments falsely describing a timed escape
from the financial barrier were corrected. There is no added database query,
new timer, credential, production mutation or financial repair call.

## Verification

- Before implementation: four real engine clock tests failed because the
  continuous settlement clock did not exist.
- After implementation: 68 tests passed across five files, including nine
  new cases, engine teardown ownership, the drain/financial barrier laws and
  the shared process liveness verdict. The clock tests hold a real tracked
  promise for 20 minutes of simulated retry heartbeats, extend its barrier,
  complete an obsolete promise and settle both success and rejection paths.
- Boundary checks cover the 30-second threshold, null and short waits,
  oldest-20 reporting without truncating the total or mutating input, both
  public callers, and the real HTTP health handler continuing to route healthy
  tables while the body names one blocked settlement.
- `npx tsc --noEmit` passed. `npm run build` completed with `tsc` and no errors.
- `git diff --check` passed. Changes were reviewed in the agent-owned worktree;
  no hook bypass, force push, direct main push or manual merge was used.

## Delivery and remaining proof

This patch is not live merely because these tests pass. At 19:08 UTC the
running engine was `6f11ed3f`, and this patch was still local pending the
normal branch/PR/publisher path. No alert rule has been installed for a metric
that production has not emitted yet; the monitoring rule file requires live
metric verification first. After normal engine adoption, verify the fields and
metrics, then wire the alert using the documented monitoring deployment path.
The age is process-local and does not claim to preserve historical wait age
across a restart. The durable database obligation ledger remains that witness.

The reported table was progressing at hand 8282823 after the 19:00 thaw.
Fleet timing still measured p50 2005 ms, p90 6815 ms and maximum 20666 ms over
1833 samples. Hand-delay outliers, lost-response buy-in recovery and physical
iPad/home-screen shortcut reconnection remain unresolved. Browser automation
continued to time out, so this is not a fresh browser/PWA acceptance claim.
