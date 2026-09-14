# The time bank store, on the riveted frame

2026-09-14. Branch `feat/riveted-spins-banner-families`. Second surface of the
felt sweep.

`TimeBankStoreModal` was the generic metallic chassis: grey gradient card,
five bevelled toggle buttons, a CSS-drawn diamond (a rotated gradient square
with a box-shadow - "a glyph stuck on top"). Diamonds leave the player's
balance here, so it wears the money frame: the riveted family, bolted corners
and the spade chip medallion.

- Eyebrow Time Banks, the title as before (Add Time Banks / Out Of Time
  Banks), the banks held as a pill - gold while there are some, red at zero.
- Price, quantity and total as rows on the glass. The quantity picker is five
  lit words on their own line, the chosen one in white ink, nothing drawn
  around any of them; `aria-pressed` as before.
- The diamond is the platform's own painted icon (`images/diamond-icon.png`,
  the one the Daily Bonus sheet prints), at text height beside the number.
- Not Now and Buy on the two painted plates; Buy reads Buying… while the
  purchase is in flight and is disabled on a shortfall, as before. The
  shortfall line prints in red on the glass.

Re-rendered, not rewritten: the quantity and busy state, the double-tap guard
in `buy()`, the server-priced total, every string, `role="dialog"`,
`aria-modal`, `aria-labelledby="tbs-title"`, and `toLocaleString()` on the
figures are unchanged.

Rendered at 393px in three states - banks held at quantity one, quantity 100
picked with a shortfall, out of banks and short - beside the old component in
the same states. Both plate labels sit inside their faces. Copy gates and
no-emoji OK; 44 tests across the table-page side-features, class resolution,
popup and hover suites.
