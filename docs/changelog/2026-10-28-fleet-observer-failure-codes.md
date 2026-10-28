# Fleet observation failures retain safe diagnostic causes

A bounded fleet observation returned an unknown partition gap after its child CLI failed, but discarded whether the failure was a timeout, transport refusal, observer cleanup or serving-identity mismatch. The CLI also discarded its three static packet/path/window admission failures.

The CLI now projects trusted control metadata into a closed failure-code vocabulary. The bounded Python driver accepts only that vocabulary from a small JSON response and otherwise records a generic classification. Timeouts, process-start failures, deadline exhaustion and unverified result contracts have separate closed codes. Raw stderr, exception messages, actor identifiers, credentials and private observation payloads are never copied into the public summary.

Failure still stops further partitions, preserves only the validated prefix, retains the original unavailable gap and refuses complete capture or full-cohort coverage. This adds diagnostic evidence, not qualification or a successful observation. Focused native/control and CLI projection tests cover known codes, unknown/private output, timeouts and partial-prefix preservation. No production observation, migration or release is included.

The remote program records the existing Docker state inspection before parsing observer stdout, so malformed output cannot hide a measured OOM flag. Exact OOM=true takes priority over generic remote unavailability. Two isolated tests execute the actual Python remote program against fake Docker replies, preserving cleanup and qualification refusal for malformed output with and without OOM; no additional remote call or deadline change is introduced.
