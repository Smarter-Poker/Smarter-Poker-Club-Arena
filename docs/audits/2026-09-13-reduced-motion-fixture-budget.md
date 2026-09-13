# Reduced-motion fixture setup and failure evidence

The multi-table reduced-motion test inherited a beforeEach that loaded every
shipped stylesheet and mounted the tab bar. Its body then created a second
manual browser context and repeated both operations in the same 30-second test
budget. Required CI34771742239 and34773003676 timed out in that case, blocking
the otherwise passing horse authority migration's source publication.

The test now configures reduced motion through Playwright contextOptions before
the inherited fixture setup. It uses the managed page and performs one bundle
load. An explicit matchMedia assertion checks that the setting actually took
effect. All timer, result and action-chip duration assertions remain. The
30-second timeout, CSS loader, stylesheets, thresholds and retries are unchanged.
The CSS job now retains test-results after its own failed step, before another
suite can replace the output directory. Previously that job's failure had no
browser artifact at all.

Native Chromium verification used the real test file, its real shared loader,
and this revision's TableTabBar.css served by a loopback HTTP fixture. Each CSS
response was delayed16seconds to reproduce a contended read budget. The old
case failed at30.0seconds while reading the second stylesheet copy. The fixed
case passed in16.3seconds with reduced motion confirmed. The existing normal
motion urgency test passed in16.5seconds, asserting800ms tab and500ms timer
animations. Neither successful run was skipped. This is a reproduction of the
duplicate-work budget defect, not proof of which individual network request
consumed the historical runner's time. Required CI still runs the complete
built stylesheet bundle and both browser projects.
