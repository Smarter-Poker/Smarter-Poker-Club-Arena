# Target the missing three-run proof without repeating qualified two-run evidence

Run 39324406602 retained a qualified natural two-run hand (40136489 at table
05d8e6bc): fresh result, both pending-to-river-to-winner transitions, every
positive recipient's actual chip landing within 2px, no witness violations and
unchanged affected client/engine identities. Its overall natural test failed
because no three-run sample arrived. That failure remains a failure; the kept
two-run evidence does not become a three-run verdict.

An optional numeric `mobile_multirun_target: 3` now requests a named three-run
only certificate. Publication admission accepts it only with literal
`mobile_multirun: true` and an absent/null engine pin, before any fixture opens.
Raw JSON is passed through to the spec; strings, booleans, arrays, objects and
other counts are refused. Missing/null target preserves the original BOTH
certificate and its subject selection exactly.

Targeted selection ranks recent three-run history and permits mandatory-three
cash tables while refusing mandatory-twice. It opens the same single foreground
observer, with the same strict admission and presentation checks, original
120-second setup, twenty-minute observation and 22-minute test ceiling. Every
fresh packet, river and positive recipient must still qualify; no historical
count, default, navigation, replacement or retry supplies success.

The named case, workflow step and retained `requestedRuns` identify the mode.
Only requested counts enter its coverage; a three-run-only result never claims
BOTH passed. Task closeout must independently combine the already qualified two
with a newly qualified three on unchanged affected runtime/provenance.

Finally, both successful and failed observations attempt the after-identity
check inside the original overall deadline, retain its verdict and preserve an
original failure if that secondary check also fails. Identity mismatch still
fails an otherwise successful proof.

Focused regression before implementation: 26 failed, 57 passed, with all 52
existing natural witness/acceptance cases passing. After: 83 passed. Tests cover
strict raw target typing/authority, unchanged default BOTH, targeted mandatory
mode/history selection and the actual publication gate before fixtures.
The connected delivery, honesty and concurrency contracts also pass: 199 cases
across five files. An unset optional target continues through the existing
default dispatch path; a defined empty or malformed target is still refused.
