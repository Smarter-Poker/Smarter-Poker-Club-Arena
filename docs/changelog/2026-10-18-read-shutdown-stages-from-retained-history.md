# Read shutdown stages from retained history

The 20:55 UTC engine cutover failed its final database proof budget and restored the previous engine. Its outgoing process reached the 40-second shutdown deadline. The existing read-only diagnostic exported the deadline but omitted already logged lifecycle milestones, preventing attribution of that wait.

Include fixed categories and timestamps for existing producer stops, table drain and completed ownership release in the same bounded current/archive log reader. Raw records, table counts and identifiers remain private. There is no runtime, release, freeze, ownership or financial change. This is a diagnostic prerequisite, not a claim that the shutdown or late starts are fixed.

The actual Python parser regression proves these milestones were absent before and present after, while retaining the existing no-raw-output and authority checks.
