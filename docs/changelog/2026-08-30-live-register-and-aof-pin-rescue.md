# 2026-08-30 — The entry register stays live, and a red main pin rescued

1. LIVE REGISTER. EntriesTab's one detail query ran exactly once, so a
   register left open during a running event froze: rebuys, add-ons and
   player numbers never refreshed. While the event is ANNOUNCED/REGISTERING/
   RUNNING the same query now re-runs every 20s — only while the tab is
   visible (a hidden tab skips the round trip and keeps the cadence). A
   finished event queries once, as before: history does not poll.

2. FIX-FIRST: main was RED on tests/unit/allInOrFold.test.ts. The V28
   sitting-out work added an earlier, unrelated 'all_in_or_fold' mention to
   ServerTableEngineTurns.ts; the pin's sliceEnclosingBlock anchor drifted
   onto it and the pin failed while the coercion it guards was untouched.
   This was about to fail the client suite inside build-for-world-hub and
   block publishing for the estate. The pin now anchors on the coercion's own
   unique condition string.

Suites: 672 client test files green after both changes; typecheck clean.
