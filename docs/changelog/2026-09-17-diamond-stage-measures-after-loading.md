# Diamond game stages measure after loading

Live verification of the published Diamond Spins wheel found it stayed at the 300px fallback inside an 878px stage. The measurement effect ran while the loading skeleton was mounted, before its stage ref existed, and never attached afterward.

The measurement hook now observes the actual attached element, disconnecting when it changes or unmounts. This fixes the wheel and its existing Plinko/Crash consumers without changing artwork, game rules, wallet settlement or database configuration.

The real wheel-page regression reproduces the delayed state response: it failed before the repair (300 instead of 878), then passed with desktop measurement, phone resizing and observer cleanup. Required provider checks and live publication are recorded separately in the task evidence.

The same live entry check found the shared "Spin The Wheel" action and Crash's secondary action linked to the old game catalog. Both now open the wheel directly. The Plinko navigation regression failed before the route correction; Plinko and both Crash controls verify the exact wheel destination without admitting a wager.

The required accounting job then exposed an aging fixture in the hand-index concurrency probe: its hourly writer walked from a fixed September 13 seed to the current date. The previous successful run already took 14.975 seconds against a 15-second private deadline; the next run exceeded it. Seed boundaries now derive once from the isolated database clock, preserving the same relative hours, real function bodies, 60-minute calls, concurrency gates, assertions and deadline. An executed guard reads the seeded cursor and bounds the fixture to three hourly windows. No production function or timeout changed.
