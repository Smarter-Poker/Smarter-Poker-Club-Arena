# Home Screen Shell Recovery

Daniel confirmed that the frozen iPad table was opened from a Home Screen
shortcut. This narrows the investigation to the web application and its
service worker, rather than a separately distributed native bundle.

The shell update hook left its service-worker verification latch set for the
lifetime of a hanging fetch or response body. Later service-worker update
messages then returned without another verification. It also only checked
freshness after events; pageshow could already have fired before React mounted.

Both shell read paths now have an eight-second deadline that includes the
response body and aborts the fetch. Timeout and HTTP failure provide no evidence
of a newer build and cannot trigger a reload. The hook checks once at mount,
retains its resume throttle, and ignores results after unmount. Existing
not-at-table, visibility, cooldown and settle guards continue to govern reloads.

Regression coverage includes a hung request, hung body, subsequent successful
read, HTTP failure, mount after pageshow, immediate-resume throttling and the
service-worker verification latch recovering after timeout.

This is a reproduced update-path defect, not proof of the iPad incident's root
cause. A shortcut already executing old code must first adopt a new shell at a
safe opportunity. Do not clear authentication storage or force a mid-hand reload.
Physical iPad resume/network-switch verification and hand-delay outliers remain
open; healthy desktop play does not close those issues.

The entry-chunk review explicitly includes the small dependency-free deadline
helper. A lazy import would add a potentially hanging network prerequisite
before the timeout starts. Existing bundle-size limits remain unchanged.
