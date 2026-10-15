# tests/the-launch-has-one-health-reading.law.test.ts

fn_ca_launch_health() is the one launch readiness reading: green, amber or red for financial alerts, hand settlement, weekly closes (owner settlement floors respected), tournament liveness and scheduled jobs, plus a launch row that is the worst of them; it is a pure read, service role only, and an unreadable area counts as red.
