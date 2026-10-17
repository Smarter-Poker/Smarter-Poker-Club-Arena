# A leaderboard contrast reading must not overlap entrance motion

**2026-10-17.** Post-Deploy E2E 39031279591 (client 551d47333) passed 492 of
493 sweep cases. The one failure was `leaderboard-console.spec.ts` "Leaderboards
Are Unframed And Reachable At 430px": `My Clubs Rankings` reported 15
`color-contrast` nodes. The same assertion was green at 375, 393 and 1440px in
that run and at 430px in the previous run (39024600776).

`expectNoSeriousAxeFindings` waited for ranking entrance motion to finish and
then ran axe once. With a 500-player field, ranking rows can mount (each with
its approved fade-in) after the wait returns and while axe is measuring, so the
reading can capture a fade rather than the palette.

## Change (test only)

`leaderboardMotionSnapshot` counts ranking entries and those still entering.
The assertion takes a snapshot before and after each axe reading; when the
board shows the reading overlapped motion (an entry still entering, or the
entry count changed), it waits for motion again and re-measures, at most three
readings. A settled unreadable palette is still refused:
`leaderboard-motion-contrast.spec.ts` keeps its refusal case and now also pins
the snapshot mid-motion and settled.
