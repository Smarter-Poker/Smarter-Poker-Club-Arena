# Custom Messages Setup Toast Stops Repeating

Dan, 2026-10-21: "this pop up has to stop appearing, especially after the user has updated their messaging."

## Causes

1. `clubWelcomeSetupMissing` treated an owner as unfinished until BOTH the downline and the club owner templates were enabled and nonempty. Saving one message, or deliberately saving one switched off, never ended the nudge.
2. The "already shown" memory was a `useRef` inside `HamburgerMenu`, which `GlobalHeader` remounts on every page, so the toast fired again on every navigation.

## Fix

- Setup is missing only while the user has never saved any custom message (every template revision is 0). Any save, enabled or not, ends the nudge and the "Finish Setting Up" menu label.
- The toast is remembered in localStorage per account per club and shows at most once, ever.

Pinned in `tests/config/clubWelcomeMessageNavigation.test.ts`.
