# Cold-return preference certification

The production cold-return journey acknowledged any successful POST to the shared lobby-filter endpoint, including Advanced Filters or another tab selection. Cleanup closed the successfully returned document and restored through the older document; report 38962459129 timed out there after its primary cold-return assertion completed.

The certificate now requires a successful acknowledgement carrying the exact club and intended saved tab. It restores through the ready returned document before closing it, independently checks the restored selection in a fresh document, and keeps both journey and cleanup errors when both fail. A failed cold open explicitly falls back to the original document for cleanup.

No runtime preference behavior, timeout, retry, or business rule changes. The prior runtime timeout cause remains unproven. Regression coverage executes acknowledgement rejection and cleanup ordering, failure propagation, and production wiring.
