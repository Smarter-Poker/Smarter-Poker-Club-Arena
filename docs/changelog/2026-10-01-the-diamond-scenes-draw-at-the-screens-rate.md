# The Diamond scenes draw at the screen's own rate, rest when nobody is watching, and print sharp signs (2026-10-01)

Phase 1 of the mobile graphics programme that followed the haptics work.

## Smooth motion on every phone

Crash and Plinko drew at most once every 30 ms, about 33 frames a second, on phones whose screens refresh 60 or 120 times a second, so the flight and the falling diamonds moved in visible steps even on a fast iPhone. Donkey Cross drew at 60 while walking and was capped there on a 120 Hz screen. One rule now governs all three (`src/components/games/framePacer.ts`): while a scene moves, and for a 1.5 second grace after it so a landing's flash and ring finish smoothly, it draws on every display frame. The quality governor still steps a phone that cannot keep up down a tier; it is handed the display frame interval so a 60 Hz phone keeping up is never judged slow.

## Battery between rounds

Between rounds a settled scene draws about 30 frames a second, which is all its slow attract glow needs. After 20 seconds with nobody touching the page, it stops drawing altogether and leaves its last frame on screen. Any tap, key or scroll, or any change in what the scene shows (a new round, a new drop, an auto run starting), wakes it on the next frame. Reduced motion keeps each scene's own slow pace and parks the same way.

## Sharp street signs

A near Donkey Cross sign covers more device pixels on a 2x or 3x phone than its 256 x 128 slot held, so its lettering was stretched and soft. On any screen sharper than 1.25x the sign atlas is now painted at twice the size; the layout stays in sign units. The Plinko bucket plates and title are drawn larger than they appear and are already mipmapped, and Crash's labels are SVG over the scene, so neither needed a change.

## Edge smoothing at low quality: checked, no change

Every Diamond renderer is created with multisample antialiasing, which smooths edges at every quality tier, including the lowest (1x pixels, no shadows). An extra full-screen smoothing pass would add GPU work on exactly the phones the governor stepped down, so none was added.

## Tests

`tests/unit/framePacer.test.ts` (moving, grace, settled, parked, woken by a tap or a new round, reduced motion, the governor interval, the sign scale), `tests/components/ChoiceScenePresentation.test.tsx` (30 a second after the grace, parks after 20 seconds, wakes on a tap) and `tests/components/DiamondGamesSound.test.tsx` (Crash and Plinko draw every frame of a 120 Hz flight and drop, Crash parks between rounds).
