# Root lobby footer and chrome height correction

## User-visible change

- The Club Arena root lobby (`/`) no longer renders the global six-button footer.
- The root lobby no longer reserves hidden footer clearance, returning that space to the club cards.
- The shared global header is capped at 84px and the footer at 108px on larger screens.
- Both bars retain all of their controls, full-width artwork, and touch-safe hit regions.
- The compact footer height is defined in the runtime `club-engine.css` entry sheet, not only in legacy token sheets.

## Verification

- Route-policy coverage pins `/` and an empty pathname as footerless.
- Footer-clearance coverage pins the root lobby to ordinary 16px bottom padding.
- Header and footer CSS coverage pins the new compact height contracts.
