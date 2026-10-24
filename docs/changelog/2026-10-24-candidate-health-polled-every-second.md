# The Candidate Is Noticed The Second It Is Ready

After a cutover launch, `server/scripts/engine-release-transaction.sh` waits for the candidate's exact local health and then for the public proxy to serve the same instance before the final database proof. Both loops slept 5 seconds between reads, so a ready candidate lost on average 2.5 seconds (up to 5) twice. Release e4f793b6 reached the final database proof 7-10 seconds too late for its 17-second floor above the 135-second rollback reserve and rolled back on 2026-10-24.

Both loops now read every second. Their total windows (180 seconds local, 90 seconds public), every identity proof, the rollback reserve and the database proof floor are unchanged. Pinned by `tests/the-candidate-is-noticed-the-second-it-is-ready.law.test.ts`.
