# Reduced Motion Uses One Table Fixture

The reduced-motion animation check inherited a full stylesheet load and table mount, then opened a second context and repeated both inside the same 30-second test budget. A slow stylesheet could exhaust the budget before the motion assertions ran.

Set reduced motion on the nested Playwright fixture before setup and use its page. The test still verifies the media preference and requires every observed animation to collapse to at most one millisecond. Ordinary tests retain their default motion preference; no timeout, retry, CSS, or animation assertion is relaxed.

Validation: with a 16-second stylesheet response, the original test times out on its second load; the corrected test passes in 16.1 seconds. A separate real-Chromium control verifies the same ordinary deal and winner effects remain 350ms and 600ms. The local fixture serves actual component styles and the global reduced-motion stylesheet. An exploratory full-hand control failed to observe a 50ms materialization effect; complete shipped-CSS CI is required before acceptance.

CI change detection also treats browser specifications, shared browser fixtures, and Playwright configuration as browser-build inputs. Previously a test-only fix skipped its own CSS qualification job. Immutable Git rename/deletion coverage and unrelated-path controls protect this routing.
