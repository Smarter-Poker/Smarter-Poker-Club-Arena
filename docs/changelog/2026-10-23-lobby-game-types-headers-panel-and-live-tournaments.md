# Lobby: Game Type Keys, Readable Headings, One-Frame Panel, Live Tournament Rows

Dan, 2026-10-23, four requests on the club lobby.

## 1. Game types outrank the filters

"FOR THE GAME TYPE. THESE SHOULD BE SLIGHTLY LARGER FIXED SIZED BOXES THEN THE
FILTERS BELOW IT. AND WE HAVE TO ADD SOME DEPTH OR SHADOWING TO THE BOXES."

`src/pages/ClubHomePage.css`, final block "GAME TYPES OUTRANK THE FILTERS":
every game type is one fixed 76px x 50px key (68px under 430px), the status
filters stay 44px tall and auto width, and both rows are raised keys (top bevel,
dark lower lip, drop shadow). The selected key presses in and glows blue.

## 2. Column headings and the sort that did nothing

"THE GAMES STAKES PLAYERS AND STATUS FONT NEED TO BE LARGER. PLAYERS AND
STATUS DON'T CHANGE WHEN THEY ARE CLICKED."

Headings are 13px Roboto Condensed (compact board) and 0.8125rem (wide board),
the sorted heading lit blue.

Root cause of the dead sort: `sink()` in `LobbyTable.tsx` floated every
featured, enterable game above every ordering. On a board led by featured games
a Players or Status tap reordered only the rows under them, so the top of the
list never moved. The featured pin now applies to the default order only; once
the player taps a heading (or a remembered heading is restored) that heading
orders the whole board. Equal statuses now tie-break by start time, then by
players, so a Status tap always produces a deliberate order. Empty cash tables
and dead seat-first games still sink, as Dan ruled on 2026-09-03 and 2026-08-25.

## 3. Only the game card has a frame

"ONLY THE 'GAME CARD' SHOULD HAVE A FRAME, ALL THE REST OF THE INFO SHOULD BE
DISPLAYED IN ITS REGULAR WEB PAGE LAYOUT."

The shark-console plaques under the cash card (`shark-panel-v1` top, mid,
bottom, bay and button art) and the SpadeConsole frames under the tournament
card are gone. `PanelSection` in `GameLobbyPanel.tsx` renders each section as a
page section: a lit heading with its status word, facts as label and value rows
on hairline rules, seat tiles, a plain rules list and an ordinary Back To All
Games button. The approved game card keeps its art.

## 4. Tournament rows that look alive

Compact and wide boards print badges with drawn icons for PKO, Mystery Bounty,
Bounty, Satellite and Freeroll, a gold badge for any guarantee of 2.5K or more
(`HOT_GUARANTEE_THRESHOLD`), and a live clock: "Starts In 4:31" before the start
and "Late Reg Ends In 12:03" while late registration is open, from the same
`lateRegEndMs` window the server enforces. Freeroll, big-guarantee and bounty
rows carry a coloured rail on the compact board.

Pinned by `tests/unit/lobbyTournamentRowsAreAlive.test.tsx` and the updated
`tests/unit/premiumTournamentConsoleContract.test.ts`.
