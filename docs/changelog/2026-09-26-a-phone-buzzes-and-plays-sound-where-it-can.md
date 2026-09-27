# A phone buzzes and plays sound where it can, and says where it cannot (2026-09-26)

Dan, 2026-09-26: "there are no buzzing or haptics".

## Why nothing buzzed

Apple has never shipped the Vibration API in any iPhone browser. Club Arena faked a buzz on iPhones by toggling a hidden native switch (`<input type="checkbox" switch>`) from script, the trick in `src/utils/vibrationGate.ts` since 2026-09-05. iOS 26.5 closed it: a scripted toggle still flips the switch and the phone stays still. What survives is a real finger landing on a real switch. Safari 26 also froze the OS number in its user agent at 18.6, so the old version check still believed the trick worked. The Diamond game beats from Phase 5 (the crash, the landing, the gem) are fired when the picture shows them, seconds after any tap, so on an iPhone browser they could never buzz at all.

## What changed

- **TapHaptic** (`src/components/haptics/TapHaptic.tsx`): on an iPhone or iPad browser only, a tap target that should buzz carries an invisible native switch over its whole face. The finger lands on the switch, iOS plays its tick, and the click goes on to the button exactly as before. It is out of the tab order and hidden from assistive technology, is never drawn on a disabled control, follows the Vibrations switch live, and a scripted buzz asked for inside the same tap is not played twice (`markSwitchTap`). It is on every Diamond game control (both console plates and the pressable bays of Crash, Plinko, Donkey Cross and Mines, every Mines tile, the wheel's plates, run panels and card table) and on the poker table's Fold, Check, Call, Raise, All In and confirm buttons.
- **Every Diamond tap asks for its buzz in the tap**, for Android and the app: Plinko's plates (they had none), the Mines tile (a selection tick as the finger lands), and Donkey Cross and Mines Start Round (it buzzed only after the server answered).
- **Game sound plays with the iPhone on silent.** Safari plays web audio in an ambient session that the ring/silent switch mutes. With Sounds on, the sound engine asks for a playback session (`src/utils/audioSession.ts`), heard like a video, at the moment it is about to play its first sound (never at load, and never on the first tap that wakes the engine). With Sounds off, from any switch or settings sync, it goes back to ambient at once. The trade-off: like any app that plays sound, the first game sound pauses music another app was playing; a player who wants their music turns Sounds off.
- **The Vibrations switch says what it can do.** Under the switch: "On IPhone Browsers, Buttons Buzz As You Tap Them." on an iPhone browser, "This Browser Cannot Vibrate." where nothing can, and "Buzzes On Phones With A Vibration Motor." on a computer. Turning it on buzzes; turning it off does not.
- **Device Check** (menu, under Table Studio; it closes the menu and opens on top, like Table Studio): the device and browser, what vibration can do here, the Sounds and Vibrations settings, the sound engine, how the silent switch treats game sound, the WebGL renderer and whether the GPU or the CPU draws it, the quality tier the Diamond games settled on, the screen, and a three second smoothness measurement. Test Vibration asks "Did You Feel The Buzz?" and records whether the device accepted it, Test Sound asks "Did You Hear The Sound?" (or says why nothing can play), and Copy Report puts the whole check, answers included, on the clipboard, or in a box to copy by hand where the clipboard is blocked.

## Not possible on an iPhone browser

A beat that no finger starts (the crash, a Plinko landing, a gem turning over) cannot buzz in any iPhone browser after iOS 26.5; only the app, through `@capacitor/haptics`, can. Those beats keep their sound, and still buzz on Android and in the app.

## Tests

`tests/components/TapHaptic.test.tsx`, `tests/components/DiamondGamesTapBuzz.test.tsx`, `tests/components/DeviceCheck.test.tsx`, `tests/unit/audioSession.test.ts`, `tests/unit/deviceReport.test.ts`, and a real-browser iPhone case in `tests/e2e/css/diamond-games-playfield.spec.ts` that plays Mines with taps and checks every live control carries a switch that covers it exactly.

## Audit follow-up (2026-09-27)

A second read of this change found and fixed: the Device Check opened behind the menu (the shared modal stacks at 1000, the drawer at 9500), so it now closes the menu first like Table Studio, pinned in `tests/unit/hamburgerMenuLaw.test.ts`; the playback session was set at load, so the first tap that woke the sound engine could pause a player's music, and it is now set only with the first real sound; a table settings sync turned sound off by writing storage directly and left the session in playback, and now goes through the engine; the two shared focus traps counted the hidden switches as keyboard stops; a fixed-limit Raise tap buzzed twice on Android and in the app; and the switch was added to the remaining committing table taps (Pineapple discard, Insurance and EV Cashout plates, Show, Muck and Reveal, the four pre-actions, the raise steppers and presets).
