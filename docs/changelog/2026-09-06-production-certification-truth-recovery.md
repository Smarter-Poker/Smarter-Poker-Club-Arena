# Production Certification Truth Recovery

## Failure inventory

The queued post-deploy sweeps exposed two assertion defects after the Club Arena
navigation release and one third-party telemetry condition that was being
misclassified as a product failure:

- Table Studio read four preview attributes sequentially, so a Realtime render
  could produce a mixed or already-stale snapshot that never represented one
  committed appearance.
- The commerce journey checked two open devices without first proving the exact
  row persisted in `user_theme_settings`, making a storage failure and a
  propagation delay indistinguishable.
- Chromium reports a rejected Sentry envelope as a console resource error when
  the collector rate-limits telemetry. The Cashier gates treated that collector
  backpressure as a failed Club Arena resource.
- The Hub avatar catalog moved from PNG to WebP, but Club Arena's thumbnail
  parser still recognized only PNG. Table Studio therefore requested six
  generated 404 paths for its gameplay-preview portraits.

## Repair

- Realtime and commerce appearance reads now capture all four attributes in one
  browser evaluation and poll the complete appearance as one atomic value.
- Both journeys poll the service-role view of the exact player's `ALL` settings
  row before requiring every already-open device to converge. The tests still
  fail if Realtime never updates an open device; no reload is used to hide that
  requirement.
- The realtime journey derives its expected value from the selected design
  intent instead of using the asynchronously rendered source device as its
  oracle.
- The Cashier gates ignore only HTTP 429 for the exact production Sentry
  organization, project, HTTPS origin, and envelope path. Every other 4xx/5xx,
  app/Supabase/CDN resource failure, malformed URL, and network error remains
  critical.
- Avatar thumbnails accept the Hub's legacy PNG and current WebP contracts and
  derive the physical asset tier from the catalog path. Entitlement tier still
  comes from catalog metadata, so promotional FREE access to VIP-directory art
  remains intact while the image URL resolves to the file that actually exists.
- A failed individual preview portrait now falls back to the neutral seat
  silhouette rather than exposing a browser broken-image glyph. Production
  journeys require all six portraits to decode successfully, so that fallback
  is resilience for players rather than a way for certification to pass.

No route, player setting, checkout handler, Supabase policy, Realtime channel,
or application error policy changed. These changes make the production gates
identify the failing layer without weakening the product contract.

## Pre-publication evidence

- The focused console policy suite covers the accepted envelope and 221
  rejection cases.
- Every table-art URL derived from all 97 current Hub catalog entries returns
  HTTP 200; component and mapping tests cover decoded art and the neutral
  per-image failure fallback.
- Changed-file ESLint, TypeScript `--noEmit`, Playwright discovery, and diff
  integrity pass.
- The unmodified commerce journey completed against the current live build;
  the strengthened journey then reached its cleanup gate during a deployment
  freeze. The current `main` cleanup helper explicitly waits out that freeze and
  is merged before the final production certification is run.

Publication and a zero-failure, exact-current post-deploy sweep remain required
before this recovery is complete.
