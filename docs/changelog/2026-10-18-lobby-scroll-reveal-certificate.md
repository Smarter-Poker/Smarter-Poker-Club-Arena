# Measure revealed lobby filters after an upward scroll

The hosted mobile lobby check measured the intentional down-scroll hidden state. Its retained trace showed `data-filters-hidden="true"`, with the filter row top 180 pixels above the command deck bottom, exactly the row height. The existing owner behavior hides controls when scrolling down and reveals them when scrolling up.

The production check now scrolls upward through the normal page interaction and requires the revealed state before measuring. The sticky position, real scrolling, visible row and less-than-one-pixel alignment assertions remain unchanged. Production behavior, timeouts and retries are unchanged.

Validation: retained failing hosted trace; existing direction/transform regression tests and ordinary pre-push checks. Required hosted execution and unchanged published-release closing proof remain necessary.
