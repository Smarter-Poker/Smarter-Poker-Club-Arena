# The peel runs the right way, and an iPhone can finally feel it

2026-09-05. Six things Dan reported after testing Card Slide on his phone.
Four were mine, two were older. Every one is a defect that shipped, so each
section says what was wrong, what the evidence was, and what now stops it
coming back.

---

## 1. "THE CARDS ARE STILL BACKWARDS AND DON'T PEEL RIGHT"

He sent a video of himself doing it with real cards. I had already rebuilt the
peel once from that video and still had it inverted, so this is the SECOND
correction, and the frames are worth writing down because two versions have now
been wrong in two different ways.

`ffmpeg -vf fps=4` over `CARD PEELING.MOV`:

| frame | what is on screen                                                                                                     |
| ----- | --------------------------------------------------------------------------------------------------------------------- |
| f07   | both cards flat, face down, full red back                                                                             |
| f09   | a thin band of FACE along the **TOP**: the Q and the J indices, side by side, right way up. Red back still below them |
| f11   | taller - the court art appears UNDER the indices                                                                      |
| f13   | taller again, both faces readable                                                                                     |
| f17   | effectively the whole pair, a sliver of red left                                                                      |

He is not folding the card over at all. He TIPS the pair toward himself,
pivoting on the near edge, so the face arrives from the **top down** and reads
the right way up the whole time. That last part is why nothing mirrors or
reflects any more.

- **v1** folded a CORNER diagonally, page-curl style, with a dog-ear flap and a
  synthetic rank index printed under it.
- **v2** got the horizontal boundary right and ran it the wrong way - face
  revealed bottom-up. That is what "still backwards" meant.
- **v3**, here, reveals top-down.

`cardPeel.ts` is four lines of arithmetic; the whole fix is which edge each
`inset()` eats:

```
back  inset(<fold>% 0 0 0)          keeps everything BELOW the boundary
face  inset(0 0 <100-fold>% 0)      keeps everything ABOVE it
fold  0% at rest, travelling DOWN to 100%
```

Verified in the browser at 35% and 74% of a drag: at 35% the revealed strip is
the Q and the J; at 74% both faces are readable with the back only at the
bottom. The same cards Dan is holding in the video.

`--peel-bend` was computed and written every frame and **read by nothing** -
the comment beside the flip box described a tip toward the player that the
transform did not contain, because `perspective` as a property applies to an
element's CHILDREN, not to the element. It is now `perspective(600px)
... rotateX(calc(var(--peel-bend) * -1))` on the flip box itself, negative
because a positive `rotateX` swings the top edge AWAY.

The unit test now asserts the DIRECTION, not just that the two clips partition
the card - v2 satisfied a partition check perfectly while being backwards.

## 2. "REMOVE THE SOUND EFFECT WHEN YOU ACTUALLY PEEL YOUR CARD"

Gone. `startPeelFriction` / `updatePeelFriction` / `stopPeelFriction` - a
sustained looped-noise -> bandpass -> gain voice fed the drag speed on every
pointer move - and `playPeelLift` are **deleted from SoundService**, not left
unreferenced. Four public methods on a singleton that nothing calls are four
things the next agent has to prove are dead before touching that file.

`playCardSqueeze`, the snap as a committed peel flies open, is a different cue
and still fires. The drag itself is silent and keeps its haptics.

## 3. "NO HAPTIC OR VIBRATION WHEN TESTED"

The iOS haptic I shipped yesterday did not work, and it did not work for
reasons I could have known if I had read the source instead of the description
of the technique. Read against `ios-vibrator-pro-max@3.0.3`
(`dist/vibration.js`, `dist/methods/click-grant/index.js`,
`dist/utils/supported-versions.js`):

1. **It clicks the LABEL, never the input.** `hiddenTrigger.label.click()`. I
   was clicking the input.
2. **It never touches `.checked`.** I set `input.checked = !input.checked` and
   then called `click()`, whose own activation behaviour toggles it back - so
   the control ended every "buzz" in the state it started in.
3. **The trigger is never in the document.** Its label is created detached and
   stays detached, with `display: none !important` on the input inside. I was
   appending an off-screen `opacity:0` fixed label to `document.body` on the
   belief that an unrendered control would not fire - the opposite of what the
   library proves. Detached is better here anyway: nothing for the seat-geometry
   measurements or anyone's MutationObserver to trip over.
4. **There is a version floor and I never asked about one.** The
   click-inside-a-gesture path ("granted") only works at Safari/iOS **>= 18.4**.
   Between 18.0 and 18.4 the only thing that works is the body reparent this
   app has refused; below 18, nothing. We now return `false` there instead of
   returning `true` and leaving the caller believing the phone buzzed.

And one that would have hidden the fix even after the fix: the user-agent parse
required a `Version/` token. **A home-screen install has neither `Version/` nor
`Safari` in its UA** - just `CPU iPhone OS 18_5` - and a home-screen install is
the shape most likely to be holding a table. The OS token is read first now,
with `Version/` as the fallback for the desktop-class iPad UA that has no OS
token.

We still do not import the library. Its global `document.body` reparent, its
`document.body` getter override and its two subtree MutationObservers are not
things to take on for a buzz in an app that measures the DOM to place seats.

## 4. Haptics could be turned on but never off, on the platform they now work on

Three places asked "can this device vibrate?" by testing for
`navigator.vibrate`, which **does not exist on any iPhone**:

- `vibrationGate.isVibrationAllowed()` - so the gate answered "no motor here"
  for the whole platform;
- `HapticService.isHapticSupported()` - `'vibrate' in navigator`;
- `TablePage`'s `TOGGLE_VIBRATIONS` handler, which computed the new value as
  `!isVibrationAllowed()`. That is `!false` on every iPhone, every time: the
  hamburger's Vibrations item could turn haptics **ON and never OFF**.

Capability is now one exported function, `isVibrationCapable()` - the native API
**or** the iOS switch path - and the toggle reads `isVibrationPreferred()`,
because a toggle inverts a preference, not a capability.

`tests/unit/settingsHaveOneOwner.test.ts` pinned the old expression. Per
CLAUDE.md 5.8 the pin moved in the same commit, and it now asserts the old form
is gone as well as the new form being present.

## 5. "HAPTICS SHOULD BE ON BY DEFAULT IN ALL TABLE SETTINGS"

Checked all four places that have to agree, and they already did:

| where                                            | default |
| ------------------------------------------------ | ------- |
| `user_table_settings.haptic_enabled` column      | `true`  |
| `useTableSettings` `DEFAULT_USER_TABLE_SETTINGS` | `true`  |
| `SettingsPanel` defaults                         | `true`  |
| both gate keys absent                            | allowed |

Dan's own row (`kingfish`) reads `haptic_enabled: true`. So nothing was
defaulting him off - section 3 is the whole reason he felt nothing, and section
4 is why he could not have fixed it from the menu.

## 6. Table Settings on mobile: no header or footer padding, X unreachable

`SettingsPanel.css` contained **zero** `env(safe-area-inset-*)`. On a notched
iPhone the header sat under the status bar and the close button went with it.
Header pads by `env(safe-area-inset-top)`, footer by
`env(safe-area-inset-bottom)`, and the close control has a 44x44 minimum -
Apple's own target size, which it was under.

---

## Global reach

Every haptic in Club Arena already funnels through `vibrationGate.fireVibration`

- `SoundService.haptic`, `HapticService.triggerHaptic`, `utils/haptic`, and the
  six private copies that were consolidated on 2026-08-20. `grep -rn
'navigator.vibrate' src/` returns only comments recording where a bypass used to
  be. So fixing the gate fixes the whole app, and adding a seventh implementation
  still means going through this one file.

The World Hub is a different story and is handled in its own repo: 49 files call
`navigator.vibrate` directly with no gate at all.

## Verification

- `npx tsc --noEmit` clean
- `npx vitest run tests/` - **1013 files, 13990 tests, 0 failures**
- The peel driven in a real browser at 375px, mid-drag, screenshotted at two
  depths against the video frames
