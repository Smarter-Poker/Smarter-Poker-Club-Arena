# 2026-09-22: an answered error never loops, and a hidden tab never replays

Owner ruling, 2026-09-21: "NO GAMES SHOULD EVER REQUIRE A USER TO CHECK
ANYTHING, THEY MUST ALWAYS AUTO START AND PLAY", and no player may be trapped
on a game page. PR #5054 fixed this class of fault on the Diamond Wheel. This
change fixes the same class on the three games a wheel award opens: Donkey
Cross and Diamond Mines (`DiamondChoicePage`), Plinko and Crash. It closes
review findings 2, 4 and 8.

## Shipped

- **An error the database answered is an answer** (review finding 2,
  `DiamondBonusService.start`). The start function used to rethrow every RPC
  error. Every award page treated anything that was not a `BonusRefusal` as
  unconfirmed, so it kept the saved wager and `useAutoSettle` replayed it every
  8 s with no end, while the exit guard held the player. That was the original
  incident without the button. Both start functions take the ticket's lock,
  then answer a request whose ticket this request already used with that
  round's receipt, before they touch an entry or a chip. So an error carrying a
  SQLSTATE means this execution rolled back, and no earlier send of the same
  request committed. Nothing was charged. The rule is the wheel's
  (`bonusErrorKind` agrees with `spinErrorKind` on every code, and a test holds
  them together):
  - 40001, 40P01, 55P03 and 57014, plus PGRST000 to PGRST003 (PostgREST could
    not reach the database): the saved request stays, and the page sends the
    same request again. Once that request has met three such answers, the
    third is a refusal.
  - Any other SQLSTATE, and any other PGRST code (nothing ran): a refusal at
    once. The service clears the saved wager and throws
    `BonusRefusal('The Game Could Not Take That Round')`. The page deals a
    fresh ticket, re-reads the award and lets the player go.
  - No code (the network, a gateway page): unchanged. The page keeps sending
    the saved wager until it hears back.
- **A receipt that will not verify stops after three.** A server answer that
  fails the service's checks ("The Bonus Response Could Not Be Verified",
  `validateBonusReceipt`, or the parsers it runs) now throws
  `BonusUnreadable`. Money may have moved, so the saved wager is kept. After the
  third such answer for the same request (`final`), the page stops sending it,
  releases the exit guard (nothing is in flight), reads the game again, and
  shows "Your Round Is Saved" (pill "Saved"; on Crash the plate reads "Round
  Saved"). Nothing is dealt or started over it. The next visit sends it once
  more.
- **A wager that could not be saved was never sent.** If `rememberBonus`
  fails for any reason other than `PriorBonusPending` (session storage full or
  blocked, or a request with no sealed commitment), the service now throws a
  `BonusRefusal` reading "This Browser Could Not Save Your Round. Nothing Was
  Charged." The RPC is never called. Before, that throw read as an unconfirmed
  wager, and the page replayed it for ever with the guard held.
- **A background tab replays nothing** (`useAutoSettle`). While
  `document.hidden` is true, the wait is held. When the tab is visible again,
  the same wait finishes: at once if it fell due meanwhile, never started over,
  never skipped. Each wait fires at most once. The signature is unchanged, so
  the wheel, the award read and every load, quote and ticket retry get the
  same behaviour.
- **Crash replays nothing behind its load-error screen** (review finding 4).
  The exit guard is off on the skeleton and on "Reconnecting To Crash". The
  saved-wager replay now also waits for `!loadError && Boolean(state)`, so it
  goes only once the game is on screen and the guard holds it.
- **The replay-before-refusal order is pinned** (review finding 8).
  `tests/a-saved-round-settles-itself.law.test.ts` now checks both start
  functions in migration 20260921185541. In `fn_diamond_bonus_start`, the
  lookup of this ticket's entry and its `'replayed',true` receipt come after
  the ticket lock and before `fn_diamond_ticket_refusal`. In
  `fn_wheel_bonus_start`, the `a.status='redeemed'` branch does the same.
  Reversed, a replay of a start that committed would be answered "gone", and
  the page would deal a fresh ticket and send the wager again: a second charge.
  Each reversal was tried locally and fails the law. A second case pins the
  service rule, the pages' use of it, the hidden-tab pause and the Crash
  condition.

## Tests

- `tests/unit/diamondBonusRecovery.test.ts`: 22 new cases run the real service
  against a mocked `rpc`. They cover each refusal code (one send, cleared),
  each passing code (three identical sends, then a refusal), a passing error
  followed by a receipt, no code and a gateway page (kept, resent),
  unverifiable answers (kept, `final` on the third, then settled by a clean
  receipt), per-request counting, and agreement with the wheel's classifier.
  Two existing tests now expect the refusal: a storage failure and a request
  with no commitment, neither of which calls the RPC.
- `tests/components/DiamondChoiceAnsweredErrors.test.tsx` (13),
  `DiamondPlinkoAnsweredErrors.test.tsx` (8) and
  `DiamondCrashAnsweredErrors.test.tsx` (10) render the real page, with the
  real `DiamondBonusService`, over a mocked `rpc`. They cover:
  - a refusal on a pressed or automatic start, and on a replayed saved wager
    (cleared, one send, guard released, no Check or Retry copy);
  - passing errors (three identical sends, then released);
  - a network error that keeps replaying on the backoff, sends nothing while
    the tab is hidden and resumes when visible;
  - three unverifiable answers (kept, stopped, released, re-read, "Your Round
    Is Saved");
  - the next visit sending the saved wager once more;
  - a storage failure (nothing sent);
  - on Crash, a failing first load (no replay until the game is on screen).
- `tests/unit/useAutoSettle.test.tsx`: four new cases (a hidden tab holds the
  wait and finishes it on return, a quick hide and show neither skips nor
  stretches the backoff, a tab hidden from the start waits, and each wait
  fires once).
- The seven existing award-page component tests mock `DiamondBonusService`.
  Each mock now spreads the real module, so the new exports are present.
- Run against the unchanged service, hook and pages from main, 57 of the new
  and changed tests fail.

## Deliberately not changed

- The rule's residual risk is the wheel's too. If the server's replay branch
  itself failed for a request an earlier send had committed (three passing
  errors, or one that does not pass), the page would show the refusal while
  the server holds the round. The round is the server's to settle either way.
  Donkey Cross and Mines show an open round on their next state read. Crash
  adopts it on the next visit. A Plinko batch settles inside the call that
  opens it, so its chips are already booked.
- A browser whose session storage throws on every access still cannot read a
  saved wager when the page loads: that first load throws and retries, as it
  did before. It belongs to the page load, outside this change. A start in such
  a browser is now refused without being sent.
- `DiamondWheelPage.tsx`, `DiamondWheelService.ts`, `playerPresence.ts` and
  the SQL are untouched. The classifier is duplicated rather than imported
  across services: the wheel service could not be edited, and a test keeps the
  two in step.
