# 2026-08-31 — Leaderboard Prize Wizard Stays Stable During Refreshes

The live Phase 2 verification found that a club-context refresh could replace
the leaderboard settings object while an owner was using the prize wizard. The
dialog depended directly on that refreshable object, so a transient membership
or settings reload could unmount it between pointer down and pointer up.

The leaderboard now snapshots the server-authorized setup when the owner opens
the wizard. That snapshot remains mounted until the owner closes the dialog or
publishes the program. Background leaderboard, membership, and settings
refreshes can no longer dismiss an in-progress wizard or expose the page below
the modal to the remainder of the click.

Late authentication hydration follows the same rule. Refreshing the signed-in
owner's club list no longer clears an already-open wizard, and prize-setup deep
links now snapshot their authorized setup before opening the dialog. A real
sign-out remains protected by the route guard and every publication attempt is
still re-authorized by the server.

The wizard is also rendered into the document-level modal layer. This keeps it
outside the leaderboard page's stacking context, so the persistent Club Arena
bottom navigation can never sit above the wizard footer or receive a Continue
click intended for the setup flow.

Publishing behavior is unchanged: the server still derives the funding owner,
program versions still activate at the next canonical period, and opening or
advancing the wizard never moves chips.
