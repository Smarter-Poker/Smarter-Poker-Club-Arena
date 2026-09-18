# Diamond game stages measure after loading

Live verification of the published Diamond Spins wheel found it stayed at the 300px fallback inside an 878px stage. The measurement effect ran while the loading skeleton was mounted, before its stage ref existed, and never attached afterward.

The measurement hook now observes the actual attached element, disconnecting when it changes or unmounts. This fixes the wheel and its existing Plinko/Crash consumers without changing artwork, game rules, wallet settlement or database configuration.

The real wheel-page regression reproduces the delayed state response: it failed before the repair (300 instead of 878), then passed with desktop measurement, phone resizing and observer cleanup. Required provider checks and live publication are recorded separately in the task evidence.
