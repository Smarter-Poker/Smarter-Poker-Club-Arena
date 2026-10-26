# Player Management shows the upline agent under the name

Dan, 2026-10-25: "IN THE PLAYERS MANAGEMENT TAB, I WANT TO SEE THE UPLINE
AGENT, UNDER THE PLAYER OR AGENTS NAME."

The roster already returned each member's direct agent (`upline_name`), but
Simple mode hid it with `display: none`, and Advanced mode squeezed it into the
subline as "Under X", truncated at 18 characters.

Now every row prints `Upline: <agent>` on its own line directly beneath the
name, in Simple and Advanced mode. A member with no agent prints no line. The
roster still nulls the upline for viewers without financial access, so their
rows are unchanged. Search by upline name still highlights the match.

Pinned by `tests/unit/playerManagementShowsTheUplineAgent.test.tsx`.
