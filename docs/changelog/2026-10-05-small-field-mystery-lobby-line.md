# The lobby never promises chests to a field of ten or fewer (2026-10-05)

Dan, verbatim: "MYSTERY BOUNTY OF 10 OR FEWER DON'T GET CHESTS, ITS TREATING
LIKE A SINGLE TABLE TOURNAMENTS WITH 50 30 20 PAYOUT PERCENTAGES".

The engine now refuses the mystery phase for ten or fewer entries (#6215) and
the database pays such an event 50/30/20 (#6218). The lobby's waiting line
(`activationStatusLine`, used by the tournament page, the detail overview and
the Mystery Bounty panel) still said chests would open "when the tournament
reaches the money", which with three paid places would read as a promise the
event will not keep. While the mystery phase is pending, the line now ends
"Fields Of Ten Or Fewer Entries Pay Flat Bounties Only". The live and complete
lines are unchanged.

Pinned by tests/unit/mysteryBountyLobby.test.ts and
tests/components/MysteryBountyPanel.test.tsx.
