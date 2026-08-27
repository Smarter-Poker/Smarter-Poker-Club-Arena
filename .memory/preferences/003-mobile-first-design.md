# PREFERENCE: Club Arena Is Mobile First

**Date:** 2026-08-27
**Scope:** Every Club Arena design, redesign, feature flow, component, graphic, customization surface, and interaction.

## Directive

Any and all designs for Club Arena must be thought through and implemented as **mobile-first design and flow**.

Mobile is the primary authored experience—not a desktop layout compressed after the fact. Start with the smallest supported phone viewport and the player's thumb-driven flow, then progressively enhance for tablets and desktop.

## Required interpretation

- Define base layout, spacing, hierarchy, and interaction behavior for phones first.
- Keep primary actions reachable, obvious, and usable one-handed where the flow allows.
- Use touch targets of at least 44×44 CSS pixels for interactive controls.
- Avoid hover-dependent discovery; hover may enhance but never unlock required information or actions.
- Prevent horizontal page overflow. Horizontal scrolling is acceptable only for clearly signposted, intentional rails such as category tabs.
- Treat limited vertical space as a core constraint: prioritize the current decision, keep controls concise, and make long option collections scroll cleanly.
- Design and verify common mobile states including safe-area insets, on-screen keyboard, reduced motion, stale saved settings, loading, errors, locked items, and slow network saves.
- Preserve poker-table readability and action safety at phone sizes before adding desktop density or decoration.
- Desktop and large-screen layouts are progressive enhancements of the mobile flow, not the source layout.

## Verification expectation

Every UI change should be reviewed at representative phone widths (including 320–390 CSS pixels), in portrait first and landscape where gameplay requires it, plus at least one tablet/desktop viewport. Keyboard focus and screen-reader semantics remain required alongside touch usability.
