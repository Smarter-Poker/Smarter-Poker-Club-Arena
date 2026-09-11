# The pager is watched by something that is not the pager

2026-09-11. `page: sms` alerts route to a webhook, and that webhook is the one
thing on this platform whose failure nothing could announce.

## What is actually wired

Worth stating plainly, because it was believed otherwise and the belief was
carried forward into a handover: **SMS paging is wired and, by the counters, it
is delivering.** Alertmanager's `pager-sms` receiver posts to the World Hub's
`/api/internal/alertmanager-page`, that route is live (it answers 401 to an
unauthenticated probe rather than 404), and it does call Twilio. Measured on
engine-01:

    alertmanager_notifications_total{integration="webhook"}                        14
    alertmanager_notifications_failed_total{integration="webhook",reason="serverError"}   0
    alertmanager_notifications_failed_total{integration="webhook",reason="clientError"}   1

Zero server errors means the route has never answered 502, and 502 is exactly
what it answers when Twilio refuses or its three `TWILIO_*` values are missing.
The single client error is a 4xx from before the bearer was in place.

The route is also careful in the way that matters: it does not swallow a failed
send. It returns 502 so Alertmanager counts it and retries.

## What was missing

Nothing read that count. Zero rules in this repo named
`alertmanager_notifications_failed_total`. So the pager could stop working and
the only thing that would have told anybody is the pager.

Two rules now, in a `pager-health` group:

- **PagerDeliveryFailing** on any webhook delivery failure in fifteen minutes.
- **CriticalEmailDeliveryFailing** on the email leg, which is the fallback the
  first one is routed to.

Neither carries `page: sms`. An alarm about the pager must not travel through
the pager, so both go to email-critical, which is a different integration with
a different provider. If both legs fail at once the remaining signal is
`MonitoringCanary` going absent, which is what that canary has always been for.

Both expressions were evaluated against live Prometheus before merging and
return no series, which is the quiet they should have today.
