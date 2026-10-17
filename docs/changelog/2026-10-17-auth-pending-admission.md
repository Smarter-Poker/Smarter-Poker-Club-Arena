# Bound pending auth admission to one native waiter per instance

The production mobile proof recovered rejected initialization correctly, but
concurrent session requests then created separate native waiters before any
callback acquired ownership. The SDK now groups waiting requests with the
same positive acquisition budget into one instance-owned admission cohort.

Native exclusive ownership and its budget remain unchanged. Every admitted
callback executes once in arrival order and retains its own value or error.
An unacquired cohort rejects with the original native error. Entered work
drains before release even when its first callback rejects. Immediate probes
and different budgets remain independent; no automatic retry is added.

The version-bound archive includes matching private declarations, readable
patch and integrity-checked deterministic generation. Actual CJS/ES-module
regressions and local native WebKit contention distinguish this repair from
initialization recovery. Hosted publication and natural mobile acceptance
remain separate evidence.
