# Fixed SNG Satellite Details Start When Full

The Details overview now uses the same exact fixed-field satellite classifier as its card and registration confirmation. Waiting six- and nine-player satellites show When Full in the hero and Starts field, omit the internal producer timestamp, and do not run a scheduled-start countdown heartbeat. Scheduled MTT clocks and actual running/completed start timestamps remain unchanged.

Rendered regression coverage reproduces the former countdown for both field sizes, checks the waiting heartbeat, and preserves scheduled, malformed-contract and running-event behavior. No artwork, layout, registration, financial, database or engine changes.
