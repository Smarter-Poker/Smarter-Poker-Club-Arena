# 2026-09-01 - The header's background, and the disc that was covering the ring

Dan, 2026-09-01: "on mobile, the global header needs the background removed on
all pages inside smarter.poker, club arena, and club commander. the profile
image needs to be fixed on most of them as well."

Two separate defects, both in `src/components/navigation/GlobalHeader.module.css`.
Both are mobile-scoped; the `@media (min-width: 901px)` block is unchanged.

## 1. The background

`.header` carried `background: #000`.

The approved artwork (`images/global-header/global-header-desktop.png`) is
opaque across its entire 1648x168 canvas, so that fill could never be seen
_behind_ the header. It was only ever visible where the artwork is **not**:

- the `padding-top: env(safe-area-inset-top, 0px)` band this same rule adds;
- the `max(env(safe-area-inset-top, 0px), 24px)` band the standalone/fullscreen
  media query at the bottom of the file forces on an installed PWA;
- the `env(safe-area-inset-left/right)` gutters `.desktopArtwork` insets by.

Every one of those is a phone. On a desktop all three are zero, which is why
nobody saw it on a laptop. So the rule's only observable effect was an opaque
black block above and beside the header on mobile - exactly the block Dan asked
to have removed.

It is now `background: transparent`. Nothing is painted by this element; the
artwork paints itself, and the bands show the page behind them.

## 2. The profile image

Measured off the artwork the header actually renders, with the source file, not
by eye. In its 1648x168 coordinate system the profile ornament is a circle:

| Feature                              | Measurement     |
| ------------------------------------ | --------------- |
| centre                               | (1159.75, 80.5) |
| outer diameter (chrome ring)         | 94 units        |
| chrome band thickness                | ~6 units        |
| aperture (dark well inside the ring) | 81 units        |

Against that, the shipped CSS was:

- `.profileBtn` painted an **opaque black disc 117.8 units across** (`width:
7.15%` of the plane, `aspect-ratio: 1`, `background: #000`,
  `border-radius: 50%`). That is wider than the whole ornament, so the approved
  chrome ring and its blue outer glow were painted out completely. What reached
  the screen was a flat black circle, not a framed portrait. The file's own rule
  three blocks up already forbids this: "NO BOXES OVER HEADER ICONS. The
  approved artwork is the icon; a rectangle drawn on top of it is a defect."
- `.profileAvatarSlot` was `width: 72%` centred at `50% / 50%` of that button -
  **84.8 units sitting 3.6 units low**. Wider than the 81-unit aperture and
  nearly as wide as the ring's outer edge, so the photo overlapped the chrome
  band on three sides and hung past it at the bottom.

Now: `.profileBtn` is a transparent hit region like every other control here,
and the slot is the measured aperture - `width: 68.7%` centred at
`50.7% / 46.9%` of the button, which is 80.95 units centred at (1159.78, 80.46).
`aspect-ratio: 1` keeps it a true circle at every width because the button is
already square in pixels. The approved ring and glow frame the photo again.

`object-fit: cover` was already correct and is now pinned against regression -
it has been flipped to `contain` twice before (#2183, #2196), and `contain`
letterboxes every non-1:1 upload with black bars instead of filling the aperture.

## Desktop is deliberately untouched

At and above 901px the artwork is squashed into a 96px band with
`object-fit: fill`, so the ornament up there is an ellipse and cannot frame a
round portrait. That is why desktop masks it instead. The opaque disc and the
72% / 50% / 50% slot are restored verbatim inside the `@media (min-width: 901px)`
block, so this is the mobile-only change Dan asked for.

## Tests

`tests/unit/GlobalHeaderNav.test.ts` pinned the old geometry, so it is updated in
this same commit (CLAUDE.md section 5 rule 8):

- new pin: `.header` declares `background: transparent` and no `#000`;
- rewritten pin: the aperture geometry, and that `.profileBtn` paints nothing;
- `object-fit: cover` pinned with an explicit `not.toContain('contain')`;
- new pin: the `@media (min-width: 901px)` slot still reads `50% / 50% / 72%`,
  so a future mobile change cannot silently move the desktop portrait.

## Club Commander

Checked and reported rather than changed: `smarter-poker-commander` has no
global header. There is no `GlobalHeader`/`UniversalHeader` component and no
reference to any `images/global-header/` asset anywhere in it; each page renders
its own local `<header className="bg-[#242526] ...">`. The header Dan describes
(hamburger, Back, Hub, wordmark, avatar, VIP, chat, bell) does not exist in that
repo, so there was nothing there to fix.

## Verification

- `npx tsc --noEmit` clean
- `npx vitest run tests/unit/GlobalHeaderNav.test.ts tests/components/GlobalHeader.test.tsx tests/approvedHamburgerGearGuard.law.test.ts` - 3 files, 54 tests, all passing
