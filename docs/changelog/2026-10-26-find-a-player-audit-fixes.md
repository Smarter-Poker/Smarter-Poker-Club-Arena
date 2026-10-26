# Find A Player: audit fixes

Line-by-line review of the locator after Dan's 2026-10-25 reports
("FIND A PLAYER ... ITS NOT FUNCTIONAL", then the deleted and test accounts).
Each item below has a test in `tests/components/FindPlayerLocator.test.tsx`
that fails without the change.

- **Picking a suggestion shows that player, at once.** It used to search the
  player's name again, which listed everyone else who shared it and cost a
  second round trip. The suggestion row is already a full result.
- **Suggestions no longer print a handle that repeats the name** ("333 @333"),
  the same rule results already followed (Dan 2026-10-16, "TOO MUCH TEXT").
- **Emptying the field clears the results** for the words that are gone.
- **Load More never lists a player twice** when presence moved them between
  pages.
- **"Player Search Is Temporarily Unavailable"** is shown when the feature
  switch is off, instead of the generic "Could Not Search Right Now".
- **The suggestion list closes when focus leaves the field**, so it cannot sit
  open over the filters or the results. Rows keep focus on press so a tap
  still lands.
- **Screen readers** get the list wired to the field (`aria-controls`,
  `aria-activedescendant`, an id per option, a label on the list).
