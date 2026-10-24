# Preserve the live payout observer's completed landing witness

The cash/reconnect check recorded eight recipient landings within two pixels, then reported three of those completed flights as disappearing before arrival. Its observer remeasured recipient geometry during the endpoint hold and ignored its existing explicit landing witness when the chip was removed.

Preserve that terminal witness on removal, matching the existing natural multirun observer. Flights without a landing witness still need a last visible position within two pixels; a missed explicit endpoint still fails. Product animations, gameplay, network recovery and table deadlines are unchanged.

A focused regression reproduces the false failure when a recipient moves after an explicit landing. The existing early-removal, pass-then-miss and wrong-endpoint tests remain enforced. This corrects verification evidence; it does not establish the original MTT continuity cause or a completed live table certificate.
