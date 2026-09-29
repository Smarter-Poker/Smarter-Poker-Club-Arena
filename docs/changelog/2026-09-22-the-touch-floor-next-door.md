# The touch floor next door

2026-09-22, immediately after `8230f28879`.

That change put `min-width: 44px` beside the `min-height: 44px` already on
`.word` in `ClubDataPage.module.css`, and the Post-Deploy run on the published
revision confirmed it: `club-data-deep.spec.ts:150` went from **52 undersized
controls to 3**. It also named the three that were left, and they are the same
defect in the component next door:

    Day   32.67 wide, 44 tall
    Week  42.09 wide, 44 tall
    Year  41.09 wide, 44 tall

Those are the reporting-period buttons in `RakeSnapshotPanel`, which renders
inside `[data-page="club-data"]`. Its shared rule `.scope, .period, .exportBtn`
declared `min-height: 44px` and nothing about width, exactly as `.word` had.
`Month` is absent from the list only because the word is long enough to clear
44px by itself, which is the tell that the floor was coming from the text
rather than from the control.

This is 10.86 rule 4: the first fix landed and left the identical trap one
level across. Rather than wait for the next Post-Deploy run to name the next
three, every control in that file that can be narrow now carries both floors:

- `.scope, .period, .exportBtn`
- `.crumbs button`
- `.pagerBtn`
- `.toolClear`

`.drill` and `.drillIn` are deliberately excluded. They declare `min-width: 0`
because they take their width from the row they sit in, so they are wide by
construction and a floor there would fight the table layout.

## Measured, not assumed

Rendered in headless Chromium against the real stylesheet at 320, 375 and
390px, with each control inside its real container class: every button is at
least 44 by 44, and `scrollWidth - clientWidth` is `0` at all three widths.
Every one of those containers (`.scopes`, `.periods`, `.crumbs`, `.pager`)
is a wrapping flex row, so the floor costs a wrap and never an overflow.

## Verified

`npx tsc --noEmit` clean; all eight gate scripts ok; source bindings intact
(no pinned file changed, no restamp required);
`tests/unit/clubDataTouchTargets.test.ts` - the existing guard for this file,
extended here rather than replaced - passes with the new two-axis pin, as does
`tests/unit/clubDataWordsAreOnTheTouchFloor.test.ts` from the previous change.
