# Lightning witness uses the controls offered by each device

The live Madness phone witness rendered a hand, fit the viewport, accepted Fast Fold and rendered the next hand, then failed waiting for Fold & Watch. The maintained capability map intentionally offers Fold & Watch only on desktop. The previous witness required it on every viewport and resized one mounted page whose capability row is read only once.

Mount each viewport through an ordinary reload of the same existing pool and authenticated browser. Require a render acknowledgement from that document, fitting layout and an accepted Fast Fold followed by the next rendered hand on all three sizes. Require Fold & Watch and its next hand on desktop. Old-document socket frames cannot qualify a new viewport. No join, buy-in, funding, consent extension, game configuration or latency ceiling changes.

The regression reproduces the old witness returning unknown when the phone correctly omits Fold & Watch. The corrected witness retains failure for a missing desktop control, old-document render frames, action refusal and cleanup failure. Actual hosted browser verification remains required after protected integration.
