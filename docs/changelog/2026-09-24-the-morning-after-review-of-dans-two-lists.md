# The morning-after review of Dan's two lists (2026-09-24)

Dan, after #5170 and #5176 went live: "before you CLAIM SUCCESS, you need to
do a deep dive and verify that every thing you've built in the previous phase
is 100% fully built, coded, wired in and tested. CHECK FOR ANY AND ALL BUGS,
GAPS, STUBS, ERRORS, REGRESSIONS OR WIRING ISSUES ANYWHERE AND EVERYWHERE."

The review was done two ways: my own read of the shipped diff against the
current tree, and an independent reviewer that had not seen the work. It found
four bugs, five gaps and a handful of nits. All are fixed here, each with the
pin that stops it coming back. Nothing in this PR is new scope: every change
closes a hole in one of the seventeen items.

## Bugs

**1. The 6-max drop narrowed the felt on real phones (item 7).** The seat rule
that lowers rings of 2 to 6 by 18px re-derived the scaler's WIDTH from the
reduced height, at specificity 0,3,0. That outranked the <=768px fill rule
(0,1,0) that exists because "THE ASPECT LOCK IS THE THING STARVING THE WIDTH"
on a notched phone, and the landscape rule's `width: auto`. Measured with the
felt harness and the real insets: a 6-max on an iPhone 12/13/14 was 350.7px
wide against 390px for a 9-max on the same phone; on a Pro Max 394 against
430; in landscape the 6-max overflowed its container by 21px. The seat rule no
longer sets a width. The drop is subtracted where each rule derives its own
height (base, phone, landscape), and on phones it comes out of the 4% of
height the 960 canvas already gives back, so it costs nothing: 386px, 430px,
and landscape inside its box. Pinned by a new beat in
`tests/e2e/table-proportions.spec.ts` that renders both rings on all thirteen
devices and names any device where the short ring starts anywhere but 18px
lower, ends outside its container, or is more than 5% narrower.

**2. The minimized Maintenance Break pill sat on the Call button (item B8).**
It hung inside the home-indicator inset on the premise that "during a break
there is nothing to act on". The screen is visible in `last_hand` (:53 to :55,
hands still finishing) and `resuming`, and minimizing is the only way to reach
the felt then. It now stands 10px above `--sp-action-reserve`, the same
clearance the waitlist banner uses: still the bottom of the page, never the
status bar, never over a button.

**3. The X on "Unlock <asset>" closed the whole Table Studio (item B6).** It
was wired to the studio's `onClose` instead of `cancelPendingAssetPurchase`,
so it skipped stopping the checkout balance poll and clearing the intent, and
it was live while the purchase was in flight. It is the Cancel plate now.

**4. Nine X's bypassed their surface's busy guard (item B6).** CashoutRequest,
UnionWallet, ChipMint, Cashier (add chips), TimeBankStore, CreateTournament,
CreateClub, CreateUnion, LeaderboardPrizeWizard, and the Table Studio itself:
each had a backdrop and a Cancel plate that refuse while money or a form is in
flight, and an X that did not. Every X now goes through the surface's own
guarded handler (`requestClose`, `closeIfIdle`) or is withheld while busy
(`busy ? undefined : onClose`, which hides the X: the console paints no
disabled state, and an absent X is how it says "not now").

## Gaps

**5. "Every popup" was thirty-seven popups.** Twenty-two consoles under a
dialog still had no X: ConfirmModal, PlayerBlock, SitOut, DiamondBust, the
Final Table / Heads Up / Winner overlays, Leave Club, the four Cashier Trade
dialogs, Confirm Transfer, Session and Quick Join, the tournament sign-up
(whose comment had removed the X as "bolted on" before Dan's ruling), the
three Game Management dialogs, the keyboard-shortcut sheet, and the three
wheel reveals (whose X follows Escape's own gate: only once the reveal has
played, never while a bonus game is ahead). Six carry no X by design and are
named with the reason in `tests/unit/everyPopupHasAnX.law.test.ts`: the TOS
gate, the required profile, the legal welcome, the two non-dismissable wheel
prompts, and the ranking card that paints its own close. That law also pins
bug 4: a console whose plates disable on a busy flag must gate its X on it.

**6. The Previous Hand sheet clipped on short viewports (item B7).** With the
sheet no longer a scroller, the fixed subheader and copy row inside the glass
could exceed the glass on a phone in landscape or an SE, and the page under
them collapsed to zero with no scroller anywhere. The glass now scrolls on the
y axis only when the fixed rows plus the page's 120px floor cannot fit; on any
taller sheet nothing changes and the page stays the one scroller.

**7. The winner's `+12.00` float (item 9).** The action badge and the stack
delta went through `formatWager`; the net-win float beside them still read
`formatStack`, so a whole-chip win printed `+12.00` next to a delta reading
`+12`. It is a wager now, and the test that pins "Raise 4" pins "+12" too.

**8. Float noise put the pot back on the cent grid (item 5).** `countGrid`
tested `Number.isInteger` on the raw endpoints; the pill is fed
`mainPot - streetBets` from the snapshot, and a 5 that arrives as
5.000000000000001 is not an integer, so the count printed 4.97 frames again.
The grid is judged on cent-squared values. Pinned with the exact noise shapes.

**9. A player released to post was in neither list (item B5).** `postBBToEnter`
deletes the player from both `waitingForBB` and `postBBWhenClear` and parks
them in `postingBBToEnter`, which the snapshot never published; between the
tap and the next deal the seat read neither list and fell through to SITTING
OUT, the case Dan named. The engine now publishes `posting_bb_user_ids` on
both the live and idle payloads, the client maps it, and the seat reads it as
`posting_bb`. Empty on an older engine, which leaves the previous behaviour
untouched until the runtime cuts over at :55. Pinned on both sides.

## Nits, also fixed

- The X's zone was outside the painted-zones overlap law. On the shark and
  riveted masters it sits in the right end of the wide title band, so a head
  with an X and no pill would have printed a long title into the glyph. The X
  is part of `consoleHeadZones` now: where its rectangle meets the wide title
  band, the title takes the narrow band exactly as it does beside a pill
  (decided by the rectangles, not by family, so the spade master keeps its
  full-width title). The overlap law runs sixteen head shapes instead of eight.
- The BBJ plate still painted the outer 1px white highlight under the
  hairline, so the bottom edge read as 2px of light. Gone from the base rule
  and both pulse keyframes; only inset highlights remain, on the face.
- The VPIP badge's third row read "MIN 30%"; Dan's words were "the 'TABLE
  MIN'". It reads TABLE MIN 30% at 10cqw, measured to 79% of the badge at
  every size the seat asks for.

## Checked and clean

tsc (client and server), eslint on every changed file, the full client unit
suite and the full server suite. Playwright: `table-proportions.spec.ts` on
chromium with the real-inset rows, all beats green, and the new beat proven to
fail on the shipped CSS (six devices named).
