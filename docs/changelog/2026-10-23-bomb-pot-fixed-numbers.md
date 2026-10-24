# Bomb Pot Wheel: Fixed Upright Numbers

The bomb pot countdown previously rotated the entire numbered disc and corrected label orientation only after the spin. The numbered disc now stays fixed throughout the reveal, while the existing selector pointer rotates around the wheel and stops at the engine-selected hand count. A replacement count remounts the selector orbit so its animation starts cleanly.

The five hand counts, result caption, active-table sound gate, chosen animation speed, reduced-motion result, callback lifetime, hold and dismissal remain intact. This is a client presentation change using the existing engine result.

Validation: TypeScript application check; focused wheel/lifecycle, animation, popup, CSS-class and error-handling checks (118 tests); copy gates; real Chrome geometry checks at 375px, 393px and 1440px for every count, sampled throughout the chase, plus reduced motion. Existing wheel tests now assert the moving selector lands on the fixed target and the labels carry no rotation. Before/after renders and measurements are retained in the task evidence checkpoint.
