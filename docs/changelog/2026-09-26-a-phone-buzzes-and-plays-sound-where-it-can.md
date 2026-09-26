# A phone buzzes and plays sound where it can, and says where it cannot (2026-09-26)

Dan, 2026-09-26: "there are no buzzing or haptics".

## Why nothing buzzed

Apple has never shipped the Vibration API in any iPhone browser. Club Arena faked a buzz on iPhones by toggling a hidden native switch (`<input type="checkbox" switch>`) from script, the trick in `src/utils/vibrationGate.ts` since 2026-09-05. iOS 26.5 closed it: a scripted toggle still flips the switch and the phone stays still. What survives is a real finger landing on a real switch. Safari 26 also froze the OS number in its user agent at 18.6, so the old version check still believed the trick worked. The Diamond game beats from Phase 5 (the crash, the landing, the gem) are fired when the picture shows them, seconds after any tap, so on an iPhone browser they could never buzz at all.

## What changed

- **TapHaptic** (`src/components/haptics/TapHaptic.tsx`): on an iPhone or iPad browser only, a tap target that should buzz carries an invisible native switch over its whole face. The finger lands on the switch, iOS plays its tick, and the click goes on to the button exactly as before. It is out of the tab order and hidden from assistive technology, is never drawn on a disabled control, follows the Vibrations switch live, and a scripted buzz asked for inside the same tap is not played twice (`markSwitchTap`). It is on every Diamond game control (both console plates and the pressable bays of Crash, Plinko, Donkey Cross and Mines, every Mines tile, the wheel's plates, run panels and card table) and on the poker table's Fold, Check, Call, Raise, All In and confirm buttons.
- **Every Diamond tap asks for its buzz in the tap**, for Android and the app: Plinko's plates (they had none), the Mines tile (a selection tick as the finger lands), and Donkey Cross and Mines Start Round (it buzzed only after the server answered).
- **Game sound plays with the iPhone on silent.** Safari plays web audio in an ambient session that the ring/silent switch mutes. With Sounds on, the app now asks for a playback session (`src/utils/audioSession.ts`), heard like a video. With Sounds off it goes back to ambient. The trade-off: like any app that plays sound, the first game sound pauses music another app was playing; a player who wants their music turns Sounds off.
- **The Vibrations switch says what it can do.** Under the switch: "On IPhone Browsers, Buttons Buzz As You Tap Them." on an iPhone browser, "This Browser Cannot Vibrate." where nothing can, and "Buzzes On Phones With A Vibration Motor." on a computer. Turning it on buzzes.
- **Device Check** (menu, under Table Studio): the device and browser, what vibration can do here, the Sounds and Vibrations settings, the sound engine, how the silent switch treats game sound, the WebGL renderer and whether the GPU or the CPU draws it, the quality tier the Diamond games settled on, the screen, and a three second smoothness measurement. Test Vibration, Test Sound and Measure Smoothness each ask "Did You Feel It?" or "Did You Hear It?", and Copy Report puts the whole check on the clipboard to paste back.

## Not possible on an iPhone browser

A beat that no finger starts (the crash, a Plinko landing, a gem turning over) cannot buzz in any iPhone browser after iOS 26.5; only the app, through `@capacitor/haptics`, can. Those beats keep their sound, and still buzz on Android and in the app.

## Tests

`tests/components/TapHaptic.test.tsx`, `tests/components/DiamondGamesTapBuzz.test.tsx`, `tests/components/DeviceCheck.test.tsx`, `tests/unit/audioSession.test.ts`, `tests/unit/deviceReport.test.ts`, and a real-browser iPhone case in `tests/e2e/css/diamond-games-playfield.spec.ts` that plays Mines with taps and checks every live control carries a switch that covers it exactly.
