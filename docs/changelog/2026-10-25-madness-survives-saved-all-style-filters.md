# Madness remains visible through saved all-style filters

The PLO5 1/2 Madness game was live but could disappear from an existing member's lobby. Before ordinary Madness became a separate style, a saved selection of Classic and Lightning covered every cash style. Adding `straight_madness` left that saved full-catalog selection narrower than it was when chosen.

The shared local/remote filter sanitizer now migrates an unversioned full old catalog to include ordinary Madness. New selections carry `stylesVersion: 1`, so a player can deliberately exclude Madness. Classic-only and Lightning-only selections remain narrow. Normal admission, game rules, wallets and seats are unchanged.

Regression coverage exercises the old names, actual row filtering, narrow selections, new exclusions and repeated cache/remote serialization. The existing production lobby browser suite also checks the real ordinary Madness row/card at 393px and 1440px, including refresh persistence and no admission/buy-in requests. Browser cases require the isolated certification identity; they never use the owner's identity or spend chips.

This is a client compatibility repair with no new engine dependency. Required checks, protected merge, the existing static publisher, both public build-info endpoints and affected live behavior remain necessary delivery evidence.

# Release-blocking Health route transfer

The protected build exposed a separate connected release blocker: the public Health route transferred 3.174MB against the unchanged 3MB budget. Its boot started speculative member-page imports, making measured transfer timing-dependent. Skip that idle preload on the Health URL, without consuming the session warm flag, so later member navigation still warms normally. A regression failed before the fix and passed afterward. Route performance qualification remains required; the budget is unchanged.
