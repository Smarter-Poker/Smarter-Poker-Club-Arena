# 2026-09-14: console wave 6, the lobby, the club data desk and the operator pages

Batch of the #ClubArenaConsole sweep on branch
`feat/console-wave6-lobby-club-operator`, off `main`. Standard:
`.claude/skills/club-arena-console/SKILL.md`.

The lobby (`HomePage`): the parts already on approved masters (club identity
card, game cards, wallets, header, sort bar) are untouched; the remaining
generic chrome is on the console: the error boundary, the offline banner
(inked, not framed), the keyboard shortcuts sheet, the clubs-failed and
welcome states, the Leave Club confirm (focus trap and `alertdialog` kept),
the cold-start skeleton replaced by one lit word. The desktop
`GameLobbyPanel` tournament variant is four consoles; trap 7.1 (rails
painting above the cap on the cash variant) is fixed with a pseudo-element
inset to the caps. `ClubAnnouncementBanner` inked; `AchievementShareCard`
and `RealTimeResultPanel` on the console (felt money through
`formatTableChips`).

The club data desk (`ClubDataPage`, 3,086 lines) is six consoles: ledger head
with Refresh / Export CSV on the plates, Data Integrity, Club Pulse, Union
Statement, and the games/players ledger as rows on the glass with lit-word
tabs and filters. Every RPC, poll, bus feed, cursor, export and cache path
survives; figures a club owner reconciles against a statement stay exact to
the cent, headline tallies compact. `RakeSnapshotPanel` is one console with
the scope and period as lit words.

Nine operator pages: Financial Health, Financial Alerts, Dispute Resolution,
MasterBus DevTools, Bomb Pot Report, Insurance Report, Table Bomb Settings,
Registration Approvals, Agent Performance Score. Gauges and bar fills are
gone; the figure is printed in threshold ink.

Dan, 2026-09-14: "THE FIRST LETTER OF EVERY WORD MUST ALWAYS BE
CAPITALIZED." Applied at every print site of data in this wave through
`titleCase()`, and recorded in the skill's law table with the reason the copy
gates cannot catch it (they read literals only).

Defects fixed beyond the paint: Financial Alerts bulk-resolve swallowed its
error; Agent Score scored off four unchecked reads (now fails closed); the
bomb pot report printed a raw uuid slice for an unnamed table; a failed
first ledger read sat under a green "Live" lamp; the rakeback share rounded
to a whole percent; three discarded Supabase error reads bound and the
ratchet tightened.

Open ruling for Dan: `ClubDataPage` carries an opt-in, labelled "Hide
Horses" toggle on the players list, pinned by three behaviour tests. It
identifies rather than excludes (10.5 allows the flag as data; the totals
row still counts everyone), so it was kept. If the toggle itself is
unwanted, that is a behaviour-and-test removal, not a paint change.

Gates in the worktree: tsc clean, five copy/CSS checks OK, 126 test files /
2,833 tests green. Renders at 393px, before beside after, in the session's
`wave6a/`, `wave6b/`, `wave6c/` folders.
