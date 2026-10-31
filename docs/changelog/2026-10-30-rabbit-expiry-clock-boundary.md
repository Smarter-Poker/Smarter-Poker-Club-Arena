# Anchor The Rabbit Expiry Test To Its Actual Hand

The paid Rabbit browser test advanced a running clock by 88 seconds after loading and opening the hand. WebKit actionability then consumed the two seconds left in the offer, so the button could expire before the test clicked it. The failed run never reached its purchase assertion.

Expose the actual hand timestamp only in the isolated fixture and pause the browser clock exactly 88 seconds after that hand. Keep the real click, the subsequent three-second expiry crossing, disabled pending state, revealed cards and exactly one request assertion. Production eligibility, payments, deadlines and handlers are unchanged.

The formerly failing iPhone WebKit case passes on real Playwright 1.58 / WebKit 26.0 with the isolated dummy-account fixture. Normal required checks and protected merge remain necessary.
