# Club Banner Save Continuity

Banner saves now notify the existing club presentation settings event. The lobby still refreshes its banner data, while permission revalidation remains reserved for membership updates.

Production certification found that the generic club update from a top-banner reset revalidated membership after 300 ms. The route guard unmounted the editor during a subsequent rotating-banner upload, so the save stopped before its settings PATCH. Both top and rotating saves, including durable-response recovery, use the presentation event to preserve the active editor. The owner checks, settings compare-and-swap and permission-revocation behavior remain enforced.

The existing isolated production certificate verifies top-banner and rotating upload, order, enable state, persistence, lobby consumption and removal. A focused regression pins the event routing.
