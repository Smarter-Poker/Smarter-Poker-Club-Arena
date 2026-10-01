# Both wheels on screen turn lite together (2026-10-01)

Found in the verification pass after the mobile graphics programme.

The wheel's lite mode (`src/components/wheel/wheelLite.ts`, Phase 4) marked only the wheel whose spin proved the phone slow. The wheel page can show two wheels at once (the cabinet wheel and the upgrade wheel, `WheelExperience.tsx`), so the other one kept all 48 animated lamps and its blurred aura on the very phone that had just proved it could not carry them, until the page was opened again. A demotion now reaches every mounted wheel through `onWheelLite`, and the wheel that proved it slow still records the lite tier in its scene summary.

Also confirmed end to end in the same pass, on this Mac with the workflow's own steps: the Diamond visual baseline's base-commit build, shots and frame diff (`scripts/ci/diamond-visual-diff.mjs`) produce a frame for every phase of all four games on both sides and a ranked diff summary.

Tests: `tests/unit/wheelLite.test.tsx` (every listener hears a demotion once and one that left does not; the cabinet wheel and the upgrade wheel both turn lite from one slow spin).
