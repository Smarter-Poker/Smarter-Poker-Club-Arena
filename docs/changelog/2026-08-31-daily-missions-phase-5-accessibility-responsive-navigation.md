# Daily Missions Phase 5: Accessible, Responsive Mission Navigation

## What Changed

- Added an action to every incomplete mission that opens the exact Club Arena
  surface capable of advancing it: cash-game lobby, tournament lobby, or
  friends directory.
- Removed the nested page-level `main` landmark so the shell owns one canonical
  main content region and the global skip link remains unambiguous.
- Upgraded the reward payoff into a labelled modal with trapped focus, Escape
  dismissal, inert background content, stable focus restoration, and no forced
  five-second timeout.
- Added semantic milestone and mission progress values, a screen-reader-visible
  realtime status, keyboard-complete tabs, and Escape/cancel focus behavior for
  inline reroll confirmation.
- Honored reduced-motion preferences for Framer Motion transitions and confetti,
  added forced-colors fallbacks, raised small-text contrast, and expanded every
  interactive control to a minimum 44px target.
- Hardened the 420px-and-below layout with stacked mission meters, two-column
  card actions, accessible freeze-purchase guidance, and scroll-safe mobile
  background behavior.

## Verification

- Mission destination unit coverage for all challenge types.
- Static accessibility regression coverage for landmarks, modal behavior,
  focus return, progress semantics, reduced motion, touch targets, contrast
  tokens, and narrow/forced-color breakpoints.
- Authenticated production keyboard, DOM, console, and responsive visual checks
  are required after protected merge and publish before this phase is complete.
