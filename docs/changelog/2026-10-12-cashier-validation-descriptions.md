# Cashier Validation Descriptions

The real Chromium production check caught an Advanced amount description that announced "Amount Validation" instead of the actual refusal. The referenced status had an aria-label overriding its content in Chromium; the mounted accessibility implementation resolved it differently. Remove that label while preserving the status role, live feedback, amount parsers and transaction guards.

All four mounted amount paths now also refuse an overriding label. Their four new assertions fail the published preimage. The maintained production check retains its exact accessible-description assertion and checks the linked status itself. Physical phone testing remains unavailable; phone widths are browser viewport checks. Provider and live evidence is recorded in the existing checkpoint.
