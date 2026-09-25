# Cash certificate invitation lifecycle

The cash browser certificate now finishes an eligible Diamond invitation after
waiting for engine progress and before checking the selected table's View action.
It retires the deferred locator handler, clicks the real Not Now control when
present, and verifies the invitation closed. The original View assertion, its
five-second deadline, spectator restrictions and hand/reconnect proof are unchanged.

Production run 35318981456 passed MTT, SNG and Spin but failed cash before table
navigation. Its trace shows the View assertion starting at 298334ms; the invitation
handler's click starts at 298550ms and finishes at 308502ms. The assertion expires
at 303520ms, leaving the handler's hidden assertion running during teardown. The
invitation arrived during API-only engine readiness, after initial lobby setup.
This evidence identifies an acceptance-test lifecycle defect; it does not establish
a missing product View button or a Diamond product defect.

The existing mobile-lobby-chrome browser fixture reproduces the same failure on
the prior helper with a late offer and delayed actionability. The repaired helper
awaits dismissal outside the short visibility assertion. A second control verifies
that no deferred handler survives navigation preparation and a missing View action
still fails. The existing realtime guard pins this preparation after engine
readiness and before the original visibility assertion. Existing CI selection
already routes all affected browser inputs through Chromium and mobile WebKit.

This change is test/support code only. It requires protected integration and a
fresh production cash certificate; local fixture success is not live verification.
