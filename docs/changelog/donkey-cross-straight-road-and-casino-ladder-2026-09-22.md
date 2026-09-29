# Donkey Cross: a straight road, a Smarter.Poker ladder, and a scene that never outruns the round

Dan, 2026-09-21: "THE STREET IS CROKED AND LEANS AT THE TOP" and "THE MULTIPLIERS
NEED TO BE SMARTER.POKER COLOR SCHEMA".

The road leaned because the camera stood 2.6 to the right of the donkey and looked
back at a point 0.6 to its right: a 10.5 degree yaw that sloped the far edge and
leaned every street to one side. The camera now stands over the x it looks at
(no yaw, no roll) with a longer lens from further back, framed by a pure function
(`crossingCameraPose`) that tests project through the real three.js camera at phone
and desktop shapes along the whole road.

The multiplier strip and the painted street signs moved to the #SmarterCasinoRealism
palette: black tiles and plates with a thin machined edge that rises dim chrome,
chrome, brass, gold toward the big streets; multipliers in silver, chip prizes in
gold; an electric-blue LED edge on the street underfoot and the next one; red for
the bust alone. The bust caption, readout and stamp lost their browns and salmons.

Scene fixes from the 2026-09-21 review: the caption never says "Next Street Clear"
(the next street is sealed; the traffic does not decide it) and reads "Your Move";
no street is lit as next once a round is booked or lost; a WebGL context the browser
gives back is drawn on again instead of staying unavailable; the car's strike is
stretched with the walk on the animation-speed setting so it never lands before the
donkey arrives; and the ghost of a booked win walks a clear route.

No odds, payouts, controls or page structure change.
