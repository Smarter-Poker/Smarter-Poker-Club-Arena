# CSP observes the first rendered document

The production sweep now navigates once to DOMContentLoaded and verifies a successful HTML document and rendered Arena or Hub application before the existing 3.5-second, scroll, and 2-second observation windows. Persistent background requests no longer consume a network-idle timeout and trigger a reload that discards the first document's violations. Navigation, rendering, scroll, and collection failures fail the check; unreadable evidence cannot become an empty report.

All five Arena and three Hub routes, the 240-second case budget, and the zero-violation assertion remain. The maintained focused regression executes the actual visit function against a persistent-request fault harness, demonstrates the old fallback losing evidence, and checks document/readiness/scroll/collector refusal. This local regression does not certify production CSP; the owning post-deploy browser sweep must run after protected delivery.
