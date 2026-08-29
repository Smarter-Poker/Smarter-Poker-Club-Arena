# Round 3 — The Bar Stops Depending On The Route

**2026-08-28** — the item rounds 1 and 2 left open, plus the last four defects
from the audit.

---

## The thing I flagged instead of fixing

Rounds 1 and 2 keep the action bar by **never leaving `/table/*`**: tournament
destinations are intercepted and rendered inside the tab. That is the right
answer for a destination the tab can render.

It is no answer at all for the ones it cannot. `ClubBottomNav` renders six links
inside the in-tab lobby — Profile, Players, Cashier, Market, Data, Stats — and
every one leaves. So do create-table, buy-diamonds, and any house ad pointing at
`/marketplace`. None of those has an in-tab renderer, and **refusing to navigate
would be worse than the bug**: the player asked to go to the cashier.

I closed round 2 by calling this "real design work, not a patch" and leaving it.
Dan's requirement does not have that exemption in it.

## The fix: stop tying the bar to the route

Off-route, `MultiTablePage` still collapses to `display: none` — the felt must
not paint over the cashier. But the **strip itself is hoisted out of the hidden
container** and fixed to the top of the viewport, above whatever page the player
went to. Same component, same props, same tap targets; only the positioning
differs, which is why it is a CSS modifier rather than a second bar to keep in
sync.

Every table stays one tap away. Urgency still flashes on the tab that owns it.
And "100% of the time" stops being a list of destinations somebody has to
remember to extend — which is the exact failure mode that produced this whole
body of work, since round 1's bug was a guard written against anchors that
quietly stopped matching.

Three things this needed:

- **A lobby tab has no `/table` URL**, and the container only un-hides for one.
  Tapping one from off-route now borrows a real open table's URL and overrides
  the index the route effect would derive from it (`pendingTabIndexRef`,
  consumed once and cleared unconditionally). Nothing is minted — the id belongs
  to a table the player genuinely has open, so a reload lands them on it.
- **Pressing the tab you are already on had been dead.** `handleTabSelect` was
  gated on `idx !== activeIndex`, which is correct on-route (a no-op) and wrong
  off-route, where that press means "take me back to my table" — and it is the
  likeliest tab to press. Only the transition animation is skipped now; the
  navigation always happens.
- **The bar has to make room for itself.** A fixed element is out of flow, so
  the first heading or back button on every page would sit underneath it. One
  `data-ca-pinned-bar` attribute on `<body>` drives the padding, cleared
  whenever the bar is not showing and on unmount.

The `LiveTablesBar` dock now renders **only for urgency**. The strip supersedes
"Return to game" — every table, not just one, in the place the player already
knows. A countdown they are about to lose money to is a different job, wants to
be loud, and sits at the bottom in thumb reach.

## Three more from the audit

**A `/table` URL never says less than the tab already knew.** The route effect
reads `?name=&stakes=&code=` to label a tab it has not built yet, falling back to
`Table <n>` with blank stakes. Every navigation now carries them (`tableQuery`),
including the round 2 backstop, which was itself a stripper. Reload after one and
a "PLO4 0.5/1" tab used to come back as "Table 1". A placeholder name is
deliberately **not** written into the URL — `Table 3` is the absence of a name,
and persisting it would make the fallback permanent.

**The drill-in survives a reload.** Reading a tournament in a lobby tab and
refreshing dropped the player onto a felt with no message: the stack was React
state, tabs rebuild from `table_seats`, and a lobby tab is not a seat. Now
persisted under its own key with a 30-minute TTL.

This is deliberately **not** the persistence that was deleted for resurrecting
zombie tabs. That stored TABLES, and a resurrected table tab claims a seat you
may have left — it implies chips. This stores a list of tournament ids somebody
was _reading_: no seat, no chips, no engine socket. It is replayed through the
same `openTournamentTab` a tap uses, so it cannot reach a state a tap could not;
it waits for the server-truth rebuild and yields to it, because a seat is worth
more than a page you were reading; and every entry is validated on the way back
in rather than trusting the blob.

**`GameLobbyPanel`'s escape hatch no longer rests on a coincidence.** Its "Back
To All Games" link goes outside `/table/*` and was safe only because
`ClubHomePage` passes `embedded={Boolean(clubIdOverride)}` and the in-tab lobby
always sets that prop — two unrelated flags agreeing, not an invariant, with an
optional boolean defaulting to false for the next render site. It now asks the
in-tab context directly.

---

## Verified

- `tsc --noEmit` clean; `eslint` on the touched files: **0 errors**
- **557 test files, 8,563 tests, all passing**
- `npm run build` clean, `behind-main=0`

`action-bar-never-leaves.law.test.ts` gains three describe blocks: the pinned bar
(fixed, above the page, clears the notch, makes room, reachable lobby tab,
same-tab press works), the URL labels, and the drill-in persistence.

One existing pin was updated in this commit rather than worked around:
`wrongTableNeverPaints.test.ts` matched the bare `navigate(\`/table/${target.id}\`)`literal. Its intent — both the tab select and the swipe commit sync the URL with`replace` — is unchanged and still asserted; the query suffix is now optional in
the pattern.

## Nothing is left open

Every item from the audit is now closed. The one thing I would still call a
judgement rather than a fix: house ads may legitimately point at in-app pages
that are not tournaments (`/marketplace`, `/clubs/:id/cashier`). Those still
navigate — but with the bar pinned, navigating no longer costs the player their
tables, so it is a destination rather than a trap.
