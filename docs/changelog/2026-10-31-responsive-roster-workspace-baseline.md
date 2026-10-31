# Wait For The Roster Preference Baseline

The production responsive audit captured the roster destination before saved
preferences finished restoring. Run 41181970917 collected all 695 general cases;
its only failure was the intended URL replacement from `/members` to
`/members?sort=name` arriving during the tablet measurement.

The existing trusted route-readiness helper now waits for the roster's enabled
workspace search control and agreement between its selected sort and canonical
URL. It does not wait for directory data, sync health, or an engine certificate.
The serving-page audit and exact full-URL checks at every viewport remain intact,
as does the 30-second case budget. Keeping the change in the already invoked
support helper preserves verifier authority when assertions come from an older
served revision.

The controlled old helper failed all three new readiness/transition cases. The
corrected focused suite passes, including negative controls that execute the
audit's actual URL assertion against changed query strings and changed paths.
No application, financial, engine, runner, or publication selector is changed.
