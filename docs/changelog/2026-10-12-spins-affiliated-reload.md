# Spins club identity after a cold reload

A production PLO6 reload retained Midway Union and the prize but lost Shark Club. The masthead correctly rejected an unrelated club, while the shared resolver stopped at that unrelated ordinary club and never reached an affiliated candidate.

The masthead now supplies its authoritative union ID to the existing resolver. This optional filter checks each account-scoped candidate against live club affiliation, then continues past unrelated or unreadable candidates. Other resolver callers retain their existing behavior. The masthead still independently validates the selected row before displaying its name.

Validation uses the actual resolver and TablePage continuation, plus the normal required checks and published live reload proof. No engine, schema, wallet, or payout behavior changes.
