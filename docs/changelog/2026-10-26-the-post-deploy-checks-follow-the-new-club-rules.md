# The Post-Deploy Checks Follow The New Club Rules

Post-deploy runs 40290005874 and 40292901952 failed four steps and eleven
tests. Two root causes, neither in the pages under test.

## 1. A fresh member now sits under the club owner

20261026031314 (Dan, 2026-10-25: "ANY 'ORPHANED' PLAYERS, OR PLAYERS WITH NO
AGENTS, GET ASSIGNED TO THE CLUB OWNER") places every new non-owner member
under the club owner. `scripts/ci/qualify-agent-assignment.mjs` still asserted
a fresh player had no agent, so it refused the KINGS CLUB owner placement
(`'47965354-...' !== null`). That failure stopped the job before
"Prepare isolated standalone template access" ran, so no private template
club was made; the notification proof then had no template, and Table
Management fell back to `DEFAULT_E2E_TEMPLATE_CLUB_ID`, Deep Stack Society,
which joined the Midway Union on 2026-10-11 and correctly refuses game
creation (`union_only`). One failed precondition, nine cascaded failures.

The qualifier now reads the club owner and accepts a fresh member under no
agent or that owner, never anyone else; the first assignment may carry that
starting upline as its expected agent. A new unit case runs the whole
assignment, transfer and cleanup from an owner placement; it fails on the
previous script.

## 2. A Lightning row is chosen by its mode, not its name

"Join Lightning from the lobby" picked the first eight cash rows whose text
said "Lightning". Many such games are not running Lightning: the variants Dan
took off Lightning on 2026-10-25, nine-handed pilots, and games below their
switch-on count. They correctly offer Join Game, and eight of them filled
every try. Lobby rows now carry `data-lightning="on"` exactly when
`game.lightning` is set - the same value that turns the door into Join
Lightning - and the check selects those rows. Unit test:
`tests/unit/lobbyRowMarksLiveLightning.test.tsx`.
