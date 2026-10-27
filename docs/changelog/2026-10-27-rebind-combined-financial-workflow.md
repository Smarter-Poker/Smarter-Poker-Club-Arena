# Rebind The Combined Financial Qualification Workflow

Club Arena publication of the Game Lobby footer stopped because the finite-original qualification manifest still held the workflow digest from one independent branch. Protected main combines the treasury proof steps from PR #8296 and the player-week qualification step from PR #8288. The combined workflow bytes therefore differ from the branch digest. Every other bound source still matches.

Bind the existing combined workflow to its exact SHA-256. The source guard and its expected byte equality remain enforced. No workflow step, SQL, financial fixture, runtime rule or production data changes. The existing law test reproduces the stale binding before this correction and passes afterward; the finite PostgreSQL 17 qualification is rerun against the bound inputs in a disposable local cluster.

This is a publication-blocker correction for footer PR #8321. It makes no production financial qualification or settlement claim.
