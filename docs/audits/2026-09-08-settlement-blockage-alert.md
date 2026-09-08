# Settlement Retry Activity Cannot Hide A Frozen Table

The permanent add-on settlement incident proved that retry progress markers can
keep the generic stall watchdog healthy while the same hand never completes.
PR #3857 added continuous settlement age independently of those markers. The
normal 19:55 engine deployment adopted ad6342df; the public health fields and
live Prometheus name catalog now both contain the new metrics.

PokerSettlementBlocked uses poker_blocked_settlements, which counts settlements
aged at least 30 seconds. It must remain positive for one minute before firing.
The existing six-minute announced-maintenance suppression covers the expected
scrape gap and thaw. This adds detection, never permission to release money
barriers or restart all tables. Existing routing is unchanged.

Publication uses the existing Deploy Monitoring workflow triggered by a merge
that touches infra/monitoring. That workflow protects live-only rules/routing,
ships the checkout, validates it and verifies Prometheus loaded the declared
rules. A merged rule is not considered installed without that final live check.

Production sampling at 20:24 showed p50 2,000ms / p90 2,004ms over the latest
2,000 hand gaps, with maximum 13,517ms. The long outliers remain open; this rule
is a backstop for sustained freezes and does not diagnose those shorter gaps.

Validation: the installed Prometheus promtool accepted the modified rule file
from stdin without replacing any live configuration. The existing monitoring
mount/loaded-rule/routing law suite passed (35 tests). Publication is still pending.
