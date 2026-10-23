# Browser closeout: cached shell and horizontal filter reach

The production tap sweep measured a clipped Late Reg filter underneath the neighbouring Filters button. The control is reachable by scrolling its horizontal rail. The audit now reveals each scroll-reachable control before probing its actual hit area, rather than treating its clipped coordinates as an overlap. The shared browser measurement is exercised directly by regression cases that still fail a genuine sibling overlap.

The service worker also discarded the original shell-cache lookup when its admission allowance expired. If that read then completed while a failing network request was pending, it still returned the offline page. Retain the original lookup result and prefer its delivered shell before the offline document. The existing cache deadline, network request count, genuine offline fallback, immutable assets and update gate are preserved. The production trace showed the offline document; the late-cache race is reproduced independently, not asserted as the only possible cause of that trace.

Customization sign-in already has the protected-main repair from PR #7828, which reaches Arena after the optional Hub phone welcome before checking Terms. Reuse that repair and verify it live instead of duplicating it. No engine replacement, financial mutation or production-setting change is part of this patch.

Validation includes failing-before/passing-after shell-cache and horizontal-rail regressions, real Chrome with actual lobby styles, TypeScript, affected worker tests, required protected checks, canonical client publication and fresh production verification.
