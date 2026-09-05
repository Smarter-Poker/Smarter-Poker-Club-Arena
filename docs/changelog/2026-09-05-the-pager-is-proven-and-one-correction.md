# The 3am pager is proven end to end, and one thing I wrote about it was wrong

2026-09-05

## PROVEN

Four successful pages and one failure, from the World Hub route's own log -
`[alertmanager-page] paged` runs only after Twilio accepts the message:

```
03:19:06  --        401  (CRON_SECRET mismatch, before the fix)
03:27:13  firing    200  paged
03:32:13  resolved  200  paged
03:34:00  firing    200  paged
03:44:00  resolved  200  paged
```

Alertmanager's own counters agree exactly:

```
alertmanager_notifications_total{integration="webhook"}                        5
alertmanager_notifications_failed_total{integration="webhook",reason="clientError"}  1
```

5 total minus 1 failed is 4 successes, and there are 4 `paged` lines. Both
halves of the loop work: a firing alert texts within ~15s, and the resolve
follows on the receiver's next `group_interval` tick.

## THE CORRECTION

The commit before this one said the RESOLVED text "did not happen" and blamed
the smoke test for setting `endsAt` to +2 minutes, shorter than
`group_interval: 5m`. **That was wrong on both counts.**

The resolve fired at 03:32:13 - five minutes after the 03:27:13 page, exactly
on the group_interval tick. Alertmanager retains a resolved alert and notifies
on the next tick even after `endsAt` has passed, so the 2-minute window was
never a problem.

What actually happened is that I read the counter at ~03:30, two minutes
before that tick, saw no increment, and wrote the absence up as a failure.

That is the same error as "an empty log means success", inverted: one reads
silence as health, the other reads not-yet as never. Both substitute an
absence for a measurement. I had criticised the first form in the same session
and then committed the second.

The `endsAt` is left at +7 minutes because margin past `group_interval` is
genuinely better hygiene, but it is margin and not a fix, and the script's
header now says so. The operational rule it carries: **if you see no RESOLVED,
wait one full `group_interval` before concluding anything.**

## WHAT ALSO GOT CORRECTED ALONG THE WAY

`resend_key` and `cron_secret` were gitignored, and the `deploy.sh` guard that
refuses to start without `cron_secret` was added, on the
`docs/sentry-realtime-programme` branch - not in PR #3054. That branch is also
where the six `page: sms` labels, the four repaired alert groups and
`tests/the-pager-list-is-exactly-six.test.ts` live. Their configs were applied
directly to engine-01, so Prometheus is running 15 groups / 74 rules with all
six labels loaded while the branch is still open.
