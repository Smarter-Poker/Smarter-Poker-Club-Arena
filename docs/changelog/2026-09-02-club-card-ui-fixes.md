# Club Card UI Fixes — 2026-09-02

## Changes

### 1. Remove silver box frame behind logos (`ClubIdentityCard.css`, `.tsx`)

**Problem**: The club identity card template PNG (`club-identity-template-no-level-v3.png`)
has a silver metallic square frame painted into it. The `.club-identity__logo` div previously
had a dark `background: #050608` that only covered the inner logo area, leaving the outer
silver frame of the artwork visible.

**Fix**: Added `.club-identity__logo-mask` — an absolutely positioned `<div>` that sits
between the shell image (`z-index: 0`) and the logo (`z-index: 1`). It covers the full
painted silver frame area (`left: 12%, top: 13%, width: 30%, height: 56%`) with a solid
dark background, effectively hiding the frame. The logo then renders frameless on top.
The logo div's own `background: #050608` was removed so there is no box behind the logo.

A new template PNG `v4` was also generated with the silver frame region erased, as an
alternative for future use.

---

### 2. Club name always fully displayed, never truncated (`ClubIdentityCard.css`)

**Problem**: Long club names like "MIDWAY UNION" were being truncated to "MIDWAY UN..."
because `.club-identity__details h2` had `white-space: nowrap` + `text-overflow: ellipsis`.

**Fix**:
- Removed `white-space: nowrap` and `text-overflow: ellipsis` from `h2` (kept on `.club-identity__line` ID buttons, which still need it)
- Added `white-space: normal; word-break: break-word; overflow-wrap: break-word` so long names wrap to a second line
- Changed `font-size: 6.1cqw` → `clamp(4cqw, 5.8cqw, 6.1cqw)` for slightly smaller names to fit better before wrapping
- Changed the details container from fixed `height: 27.48%` to `min-height: 27.48%` with `grid-template-rows: auto auto` so the container grows vertically to accommodate a 2-line name

---

### 3. Copy button icon centered, PLAYING NOW text never cut off (`ClubIdentityCard.css`)

**Problem**: The chain icon in the copy/referral button was not visually centered in the
painted button frame, and the "446 PLAYING NOW" label was getting cut off when the player
count was a large number.

**Fixes**:
- Removed `line-height: 0` from `.club-identity__share` (was causing off-centre rendering) → set to `line-height: 1`
- SVG size updated `3.75cqw → 4cqw` and added `display: block` for proper centering within the `display: grid; place-items: center` button
- Playing area `right` changed from `24.08% → 25%` to give slightly more clearance
- Playing number `font-size: 1.45em → 1.35em` — slightly smaller so the number+label fits within the allocated space
- Added `flex-shrink: 0` to the number `<strong>` so it doesn't get squeezed when the label text follows it
