# Chunk recovery keeps its tab budget

The production customization-commerce setup recorded thirteen cache-busting navigations while waiting for the profile gate. Its log does not identify every failed asset or navigation caller. Connected source inspection reproduced a definite recovery defect: every successful lazy import reset the shared two-reload counter, so an unrelated startup module could rearm a failing route on every new document.

Successful neighboring imports now preserve the tab's existing reload budget. The lazy fallback and Vite preload listener share one synchronous eligibility check, so concurrent failures share the original navigation. Once that budget is exhausted without a navigation owner, Vite receives the original import failure instead of silently suppressing it. Explicit user-driven route recovery remains available.

The existing chunk-recovery suite exercises four document instances with persistent tab storage, successful neighboring modules and simultaneous failed preloads. Both the unbounded-reload and swallowed-error regressions failed before the repair. The check now proves at most two claimed navigations and visible exhausted failures. Production publication and the affected browser certificate remain separate evidence; the retained log alone cannot attribute every historical reload to this cause.
