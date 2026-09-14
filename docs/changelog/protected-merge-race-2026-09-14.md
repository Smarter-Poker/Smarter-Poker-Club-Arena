# Handle PR changes during protected merge requests

The autopilot could fail when an author converted a ready PR to draft while its
auto-merge request was in flight. Its fallback also used the merge state from
before that request.

The queue helper now reads the current draft, hold labels, head and base, pins
both merge requests to the observed head, and re-reads after a refused request.
Concurrent draft/closed/merged/held/changed PRs and another actor's successful
queue request finish without another mutation. Unchanged failures and failed or
incomplete reads remain failures. A direct fallback still requires a fresh clean
state and required status checks; GitHub enforces ordinary branch protection.

Twenty-one tests execute the actual Bash helper with controlled GitHub replies.
They cover the observed draft race, head/base changes, stale check state,
protection refusal, and direct-merge races. The old helper fails the draft-race
case. No admin bypass, polling loop, new token, or production engine change.
