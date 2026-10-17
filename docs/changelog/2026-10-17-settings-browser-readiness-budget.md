# Match Settings Certification To Its Canonical Read Deadline

Hosted job `117352422052` failed before the Auto Time Bank persistence journey could act: the drawer's canonical settings read was still busy after the browser assertion's implicit five-second budget. The settings owner already permits an eight-second read. The retained failure has no network trace, so it does not establish request latency, a violated read deadline, or a persistence defect.

The existing conditional readiness assertion now allows that eight-second read plus the ordinary five-second DOM assertion allowance. It still requires `aria-busy=false`; every default-value, successful save, account-owned full-row read, cross-control and reload assertion remains intact. No sleep, retry, application behavior or overall case timeout changes. The existing certification contract checks the assertion budget against the canonical owner's deadline so a future shorter wait is rejected.
