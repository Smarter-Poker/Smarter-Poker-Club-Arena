# Prepare authenticated direct table links during page loading

Direct `/table/:tableId` navigation previously waited for the lazy table page to mount before starting the preparation already used by lobby entry. The persistent table layer now starts that existing preparation for an authenticated, valid table route while the table page loads. Its dynamic import preserves the lightweight entry bundle.

The effect discards delayed callbacks after a route change, account change, logout or unmount. Preparation remains optional; the actual table retains authentication, admission and error handling. Existing warmup ownership protects live table subscriptions. No connection banner threshold, production assertion, payment behavior or engine authority changed.

The existing observer-entry regression file covers the actual persistent layer, early preparation with a held table chunk, invalid routes, authentication, repeated renders, stale callbacks, StrictMode and failed speculative loading. These source checks do not certify production connection latency; the published revision still requires the existing live-table verification.
