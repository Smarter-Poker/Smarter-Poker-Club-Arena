# A Lightning Row Is Chosen By Its Mode, Not Its Name

Post-deploy runs 40290005874 and 40292901952 failed eleven tests from two
causes. The agent qualifier's "no agent" start assumption (broken by
20261026031314, a fresh member sits under the club owner) is fixed by #8169;
it was what stopped the job before its private template club was made, which
cascaded into the notification and Table Management failures.

The second cause is fixed here. "Join Lightning from the lobby" picked the
first eight cash rows whose text said "Lightning". Many such games are not
running Lightning: the variants Dan took off Lightning on 2026-10-25,
nine-handed pilots, and games below their switch-on count. They correctly
offer Join Game, and eight of them filled every try. Lobby rows now carry
`data-lightning="on"` exactly when `game.lightning` is set - the same value
that turns the door into Join Lightning - and the check selects those rows.

Unit test: `tests/unit/lobbyRowMarksLiveLightning.test.tsx` (fails without
the marker). The production spec takes effect once the client carrying the
marker is live, since the post-deploy job reads specs from the commit
production serves.
