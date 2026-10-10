# Revocation Results Belong To The Original Session

A deferred rejection for account A could arrive after account B signed in, and
the shared session-rejection handler signed out the current account B. The
isolated regression failed before the repair with a revoked verdict and local
sign-out. Probe coalescing, throttling and redirect state now belong to the
captured account and access token. A changed scope cannot refresh another
account or act on an earlier verdict; a still-current revoked session retains
the existing local-only sign-out. No server or database behavior changes.

The six maintained regression cases exercise delayed getUser and refresh
rejections, separate concurrent B probes, current-account logout and unavailable
identity, plus a deferred sign-out rejection after another login. All six and the existing 32 session law cases pass. TypeScript
`--noEmit` passes. Release and live verification remain separate from these
isolated results. The named production event remains the trigger; no polling or
snapshot comparison is added.
