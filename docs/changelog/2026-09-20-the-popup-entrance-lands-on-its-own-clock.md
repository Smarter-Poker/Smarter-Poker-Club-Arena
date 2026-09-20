# The popup entrance lands on its own clock

`main` was red on one required check, `Live-table and engine verification`, for
one WebKit case out of 299:

    [webkit-footer] tests/e2e/production-mobile-lobby-chrome.spec.ts:137:3
    the footer frame sits on the bottom edge with nothing under it

The failure was not the footer assertion. It was the shared overlay helper,
which could not dismiss a legitimate Diamond Spins invitation that had opened
over the lobby:

    - waiting for getByRole('dialog', { name: 'Diamond Spins', exact: true })
        .getByRole('button', { name: 'Not Now', exact: true })
      - locator resolved to <button type="button" class="sc-plate">...</button>
    - attempting click action
      - waiting for element to be visible, enabled and stable
      - element is not stable

## What it was not

The helper is not stale. The dialog is still named `Diamond Spins` and the
control is still named `Not Now`, exactly, in the failing run's own accessibility
snapshot, and Playwright resolved both. The prompt is not appearing where it
should not either: the isolated production account has no chips and 500
Diamonds, which is what `DiamondBustPrompt` is for.

The control simply would not hold still.

## What it was

`.ca-modal` carried two animators for one entrance. `Modal.css` animates it with
the `caModalSlideUp` keyframes; `Modal.tsx` also handed framer-motion a spring
that wrote `opacity`, `scale` and `y` into the same element's inline style. A
CSS animation outranks an inline style for as long as it runs, so the keyframes
are what a player actually saw, and when they ended the card snapped to wherever
the spring had got to.

The two keep different clocks, and that is what made it a defect. The keyframes
are time-based: they land 350ms after they start, whatever else the page is
doing. framer-motion integrates on `requestAnimationFrame` and clamps each step
to 40ms (`maxElapsed` in framer-motion 11.18.2), so on a thread that is not
handing out frames it barely advances.

Measured here, on the real `DiamondBustPrompt` at an iPhone 13 viewport, by
holding the main thread in slices and sampling the Not Now plate every frame.
The inline style read `translateY(30px) scale(0.92)` - the spring's start pose -
for the whole stuck period, while the element carried no running CSS animation
at all, so the keyframes had already finished:

| main thread   | plate comes to rest | Playwright click |
| ------------- | ------------------- | ---------------- |
| free          | 466ms               | 41ms             |
| 250ms slices  | 1280ms              | 771ms            |
| 1000ms slices | 3030ms              | 2015ms           |

The lobby certificate runs eight browsers in parallel against a live club page
under a full-screen backdrop blur, and the assertion the invitation landed in
allows five seconds. That is the whole failure: a dismiss control that is still
travelling cannot be clicked, and a player is being asked to hit a moving
target for the same seconds.

## The fix

The entrance belongs to the keyframes alone. `Modal.tsx` no longer gives the
card `variants`/`initial`/`animate`; framer-motion keeps presence and the exit,
which is what `AnimatePresence` is for. Nothing is removed or shortened: the
entrance a player sees is byte for byte the one they saw before, because the
keyframes already owned every frame of it.

With the same instrument, on the same prompt, at 1000ms slices, the card is at
`transform: none` on the first frame after mount instead of three seconds later,
and its inline transform is never written.

## What pins it

`tests/e2e/mobile-lobby-chrome.spec.ts` gains `the popup entrance is the
stylesheet's alone, and it plays`, which mounts the real shared `Modal` through
`tests/e2e/helpers/shared-popup-fixture.mjs` and requires three things: the card
still carries `caModalSlideUp`, it really is transformed on its way in, and
nothing writes a transform or an opacity into its inline style while the
keyframes run. The exit still has to close the popup, so the pin cannot be
satisfied by deleting an animation (CLAUDE.md 10.6). It fails on the previous
`Modal.tsx` in both Chromium and WebKit and passes on this one. It runs in the
existing required `CSS Beat E2E (multi-table + animations)` list, which already
carries this spec file.

## Left alone, deliberately

- `tests/e2e/support/cashLobbyOverlays.ts` and
  `tests/e2e/production-mobile-lobby-chrome.spec.ts` are unchanged. The helper
  was doing the right thing with the right names; widening the match, lengthening
  the deadline or moving the dismissal would have hidden the defect rather than
  removed it.
- `.ca-modal-overlay` has the same shape of duplication - `caModalOverlayIn` in
  the stylesheet and framer-motion animating `opacity` and `backdropFilter` over
  it - and its inline `backdrop-filter` is dead on arrival, because
  `metallic-popups.css` sets that property `!important`. The overlay does not
  move the dismiss control, so it is recorded here and not changed in this
  commit. `overlayVariants` is shared with the drawer, which has no keyframes of
  its own, so it cannot simply be stripped.
- A separate ~2.4px content reflow settles the card once, late, on a starved
  thread. It is a single frame and Playwright retries through it; it is not the
  cause of this failure.
