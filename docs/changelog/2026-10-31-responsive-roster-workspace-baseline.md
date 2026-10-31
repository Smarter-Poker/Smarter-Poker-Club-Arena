# Wait For The Roster Preference Baseline

The production responsive audit captured the roster destination before saved
preferences finished restoring. Run 41181970917 collected all 695 general cases;
its only failure was the intended URL replacement from `/members` to
`/members?sort=name` arriving during the tablet measurement.

The roster workspace now exposes semantic `aria-busy` while its account scope
hydrates or its complete canonical URL replacement awaits acknowledgement.
The same maintained serializer drives both the URL effect and readiness,
including search-query removal, filter and sort. The existing trusted
route-readiness helper waits for this workspace signal within the original
shared readiness deadline. It does not wait for directory data, sync health,
or an engine certificate. Simple mode and saved searches use the same signal;
the verifier does not guess the stored sort hidden by search mode.
The serving-page audit and exact full-URL checks at every viewport remain intact,
as does the 30-second case budget. Keeping the change in the already invoked
support helper preserves verifier authority when assertions come from an older
served revision.

The controlled old helper failed all three readiness/transition cases. The
previous component fails the four new Simple/Advanced canonical-readiness
cases. Regression coverage checks the actual component's commit observations,
pending URL acknowledgement, directory independence and the shared deadline,
including a response arriving after expiration. Negative controls execute the
audit's actual URL assertion against changed query strings and changed paths.
No financial, engine, runner, or publication selector is changed.

Later unchanged source already passed all 695 browser cases and certified Notes
in run 41189495047. That closes release acceptance, but does not remove the
earlier observed hydration race. This change hardens that finite source path;
no additional Notes acceptance suite is needed. Its helper requires the
containing published client workspace signal and cannot certify an older
client without that semantic signal.
