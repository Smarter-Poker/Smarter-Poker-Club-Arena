# 2026-10-02 — the Diamonds wheel tests wait for the receipt, not the request

`tests/components/DiamondWheelCards.test.tsx` failed CI run 36883666471 on a
branch that touched nothing near it: `Unable to find an accessible element with
the role "dialog"` in `landAndOpen`.

## Cause

The test waited for `backend.spin` to be CALLED and then clicked the wheel. The
page turns the wheel (`spinning`, which enables the mocked wheel's Land button)
only after the receipt has come back, been asserted and been rendered. On a
busy runner the click could land first, on a disabled button: nothing landed,
no reveal opened, no dialog. `DiamondWheelAutoRecovery.test.tsx` "a single
spin shows its result in the reveal..." had the same shape.

Proof: delaying the mocked receipt by 30 ms fails three of the seven card
tests with exactly the CI error; delaying the AutoRecovery receipt fails that
test the same way.

## Fix

Both tests now wait for the wheel to be enabled (the receipt is in and the
wheel is turning) before landing it, and find the reveal dialog
asynchronously. With a 400 ms receipt delay injected, both pass. Test-only;
the page is right to refuse a landing before its receipt.
