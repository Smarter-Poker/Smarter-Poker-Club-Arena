# Client errors (ClientErrorSpike)

Players' browsers report errors to a first-party sink. Sentry is retired and must not be re-added.

## Where the data is

- `public.client_error_events`: one row per reported error, or per sampled run of identical errors (`occurrences`). Written only by `public.fn_report_client_errors` (signed-in players; `user_id` is `auth.uid()`). Messages, stacks and context are PII-scrubbed and size-capped. Kept 14 days by the `client-error-events-prune` pg_cron job (`:16` every hour, 20,000 rows a run).
- `public.client_error_rates_10m`: reports, occurrences and distinct players per code per 10 minutes, last 24 hours, automated sessions excluded. service_role only.
- `public.fn_client_error_health()`: the numbers behind `poker_client_errors_10m`, `poker_client_error_users_10m` and `poker_client_error_top_code_users_10m`, collected every minute by `server/scripts/collect-monitoring-health.sh`. `poker_client_error_collect_ok` is 0 when that read failed.

## What the codes mean

- An engine code (`ACTION_CONTEXT_REQUIRED`, `SEAT_OCCUPANCY_REQUIRED`, `STALE_ACTION`, ...) or `HTTP_<status>`, source `GameServerAPI.engine_refusal`: the engine refused a request.
- The same codes with source `TablePage.action_error_shown`: the player saw the action error toast.
- `PLAYER_ERROR_SHOWN`: an error toast was shown to the player as written (`source` `Toast.error.shown`; `message` is the text).
- `BUY_IN_NOT_CONFIRMED`, `BUY_IN_CONFIRM_FAILED`: the buy-in modal could not confirm.
- `LEAVE_NOT_CONFIRMED` (or the engine's code), source `SeatLeaveIntent.*`: a leave was refused or failed.
- `TypeError`, `UNCAUGHT_ERROR`, source `window.onerror`: an uncaught exception.
- source `main.Unhandled_promise_rejection_caught`: an unhandled promise rejection.
- Anything else: the error's own code (a Postgres or PostgREST code) or name, with `source` naming the `reportError` call site.

## When it fires

1. `SELECT * FROM public.client_error_rates_10m ORDER BY bucket_start DESC, users DESC LIMIT 20;`
2. `SELECT received_at, code, source, route, app_version, message, context FROM public.client_error_events WHERE code = '<code>' ORDER BY received_at DESC LIMIT 20;`
3. Compare `app_version` with `https://smarter.poker/hub/club-arena/build-info.json`: a fault that started with a publish names its build.
4. Fix the cause at its source. Do not raise the threshold to silence a real fault.
