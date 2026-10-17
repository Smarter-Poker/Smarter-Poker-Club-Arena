# The Wallet Desk Sits Over The App

**Date:** 2026-10-17
**Law:** `tests/wallet-desk-sits-over-the-app.law.test.ts`

## What Was Broken

The union wallet desk shipped in #7169 opened under the Midway Union lobby's
fixed bottom nav and global header. `.wdesk` declared z-index 1300, but it was
rendered inside the lobby's stacking context, so the nav (1000) and header
(390) painted over it: on a phone the dock's Pull Back, Ledger and Send Out
could not be tapped (`elementFromPoint` landed on the nav), and the header hid
the desk's title. The render harness had no nav, so it never showed.

## What Changed

- The union desk and the Diamond desk are portaled to `document.body`, and
  `.wdesk` sits at 9990: over the header, the bottom nav, the MTT ticker and
  the hamburger menu, under the Diamond backdrop and the toasts.
- While a sheet is up, the desk behind it is `inert` and hidden from assistive
  tech; the union sheet holds its own focus trap and returns focus to the dock
  word that opened it, and the Diamond desk scopes Tab to the sheet.
- The Diamond desk's focus fallback is the desk itself (the trap wrapper is
  `display: contents` and cannot take focus).
- The read-only Spins Treasury desk prints Read Only on its dock line and no
  dead disabled button.
- The Diamond history pages: 50 at a time on a unique order (created_at, then
  id), Load Older Diamonds, a retry when a later page fails, and an end line.
