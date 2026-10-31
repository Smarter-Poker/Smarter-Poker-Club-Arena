# Older Bomb-Pot Hands Remain Reachable In Table Review

The table review fetched only the newest 50 owned hands and disabled Older Hand at that boundary. Production hand #45690113 remained recorded at its original table, but 367 newer owned hands made it unreachable from that table's review.

The existing Older Hand arrow now requests another 50 canonical table hands at the loaded boundary, using the oldest hand number as a keyset cursor. The same private hand mapper supplies bomb metadata, boards, pots, results and replay identity. No access rule or engine behavior changes. Native Lightning keeps its existing session-backed read path.

Older pages are merged by immutable hand ID and survive first-page refreshes and saved-hand arrivals. Viewer/table/pool changes clear the pages, late scoped responses cannot commit, duplicate page requests are blocked, failed reads retain the current hand and permit an explicit retry, and a late page cannot move a closed/reopened modal.

Focused regression coverage reproduces the disabled-boundary failure before the modal change and the older-bomb exclusion before the service cursor change, then verifies paging, live arrivals, retained pages, private scope and late navigation. Publication and affected live verification are recorded separately in the task checkpoint.
