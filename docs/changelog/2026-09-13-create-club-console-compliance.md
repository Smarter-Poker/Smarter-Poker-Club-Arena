# Create A Club Console Compliance

## Scope

- Rebuilt the direct Create A Club journey on the approved `SpadeConsole` master artwork.
- Covered the full creation page, all eight Opening Wizard subpages, and the new-club Launch Checklist.
- Preserved the existing creation, eligibility, draft, logo upload, opening-ledger, skip, and completion wiring.

## Visual System

- Replaced generic modal shells, flat cards, CSS-built frames, and generic action buttons with painted console artwork and integrated crest holders.
- Kept all ten curated 1024-pixel placeholder crest renders and the custom upload flow.
- Removed all AI-logo creation UI from this journey.
- Kept every user-facing string in Title Case and replaced symbolic completion marks with readable words.

## Responsive And Accessibility

- Converted Create A Club and the Opening Wizard into full-viewport consoles with independently scrolling bodies and permanently reachable painted action plates.
- Prevented the global legacy popup theme from stripping the console header artwork.
- Constrained the Opening Wizard step rail so it scrolls inside the frame without widening or clipping the page.
- Preserved dialog labelling, keyboard focus treatment, progress semantics, disabled states, and reduced-motion behavior.

## Verification

- Added `tests/create-club-console-compliance.test.ts` to enforce the approved chassis, ten-logo inventory, no-AI rule, no generic gradient/frame construction, readable completion labels, full-page layout, and completed-checklist removal.
- Rendered the complete journey at 393 pixels and desktop width, including all eight Opening Wizard steps.
- Verified zero page-level horizontal overflow and full action availability at both sizes.
