# 2026-09-04 - the club popup never covers the page

Dan: "THE CLUB POP UP, IS STILL BROKEN... IT BLOCKS THE ENTIRE PAGE, EVEN WHEN
ITS 'SMALL'. (YOU CAN SEE IT SLIGHTLY STILL). FIX THIS ISSUE AT ITS ROOT CAUSE,
AND PREVENT IT FROM HAPPENING AGAIN."

## What the screenshot actually showed

Every pixel of the page area in Dan's screenshot is under 28/255 brightness -
the card included. The club name (`#c8a65a`, orange) read as `(15, 17, 19)`,
no hue at all. Contrast-stretched, the whole page is blurred, and so is the
card. That is not a dark backdrop BEHIND a card; it is a dark, blurred sheet
ON TOP of the card.

## Root cause, measured on the live Midway Union lobby

The shared `components/common/Modal` painted its backdrop as `.modal-overlay`
and its card as `.modal`. Both are plain global class names, and this repo
defines `.modal-overlay` in nine other stylesheets (CashoutRequestModal.css,
TournamentPage.css, ClubSettingsPage.css, ReportReviewPage.css, ...), `.modal`
in sixteen, `.modal-content` in five. In a code-split SPA the cascade between
them is settled by which chunk the browser loaded last.

With the greeting open, the live computed style of the backdrop was

    position: fixed        (Modal.css says absolute)
    z-index: 1000          (Modal.css says auto)
    background: rgba(1, 4, 9, 0.82) + blur(9px)   (the popup chassis, intended)

and `document.elementsFromPoint()` on the club name returned
`[.modal-overlay, h2.club-entry-message__club, ...]` - the backdrop first.
Inside `.modal-portal`'s stacking context a backdrop at z-index 1000 sits
above a card with no z-index. So the sheet meant to sit behind the card sat on
it, 82% black and 9px blurred, and a 480x342 card became a faint smear under
a full-screen sheet.

#2899 and #2902 shrank the card and were both correct and both beside the
point: a small card under a full-screen sheet still blocks the entire page.

## The fix

1. **Every class the shared Modal defines and emits is now `ca-modal*`**
   (`ca-modal-portal`, `ca-modal-overlay`, `ca-modal`, `ca-modal--<size>`,
   `ca-modal-header`, `ca-modal-title`, `ca-modal-close`, `ca-modal-content`,
   `ca-modal-footer`, `ca-modal-footer--<align>`, and the Drawer/AlertDialog
   equivalents). None of these names exists anywhere else in `src/`.
2. **The card is explicitly above its own backdrop**: overlay `z-index: 0`,
   card `z-index: 1`, both inside the portal's stacking context, both stated
   rather than left to DOM order.
3. `ClubEntryMessage.css` follows the rename (`.ca-modal--fullscreen`,
   `> .ca-modal-content`) and loses a duplicated rule block.
4. `metallic-popups.css` (the popup chassis) lists the new names explicitly so
   the shared modal keeps the house paint. It paints only; see the law.

## The law that keeps it fixed

`tests/the-shared-modal-owns-its-class-names.law.test.ts` (registered in
`docs/laws.d/`):

- every class in `Modal.css` carries the prefix;
- every class `Modal.tsx` emits is one `Modal.css` defines;
- no other stylesheet in `src/` may write a rule for one of those classes.
  The one allowed reader is `metallic-popups.css`, and it may only PAINT
  (background, border, shadow, type) - a `position`, a size or a `z-index`
  from it fails the test. A consumer may still style its OWN instance
  (`.my-modal.ca-modal--fullscreen > .ca-modal-content`), which is how the
  greeting does it;
- the card's z-index is greater than the overlay's and the overlay is
  `position: absolute`.

Verified the law fails on both regressions before shipping: an external
`.ca-modal-overlay { position: fixed; z-index: 1000 }` and a chassis
`.ca-modal-overlay { z-index: 5 !important }`.

## Not fixed here, deliberately

The other nine `.modal-overlay` definitions still collide with EACH OTHER.
They happen to agree (fixed, inset 0, z-index 1000, flex-centred), so nothing
visible is wrong today, but any of them could be the next victim of the same
mechanism. Each of those components would need its own namespace; that is a
separate, wider change.

## Also seen on the way, not changed

- The four club `lobby_message` rows all have `updated_at` set again
  (2026-09-05 01:21 UTC), so `fn_get_club_entry_message`'s "only a message
  somebody wrote earns the screen" gate (#2910) now shows the greeting to
  everyone. Data, not code; not touched.
- `club-arena/.env.local`'s `SP_EMAIL`/`TEST_USER_EMAIL` is
  `daniel@smarter.poker`, which belongs to no club and bounces to `/invite/`
  on every lobby. `e2e-live/` runs need the CLAUDE.md test account
  (`daniel@bekavactrading.com`, owner of all four clubs).
