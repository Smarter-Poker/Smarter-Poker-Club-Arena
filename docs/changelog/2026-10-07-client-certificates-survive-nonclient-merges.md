# Client certificates survive qualified nonclient merges

Every main push previously built a new client version, including database,
verification and engine-only changes. That changed VITE_APP_VERSION and the
actual served SHA, repeatedly superseding an otherwise successful live browser
certificate.

The existing publisher now records the actual app, standalone Diamond and
prerender module/watch closures and conservative client/build/config/package/
publication-control inputs in the sealed production artifact. A later event
still selects exact current protected main and compares the entire deployed
baseline-to-target backlog. It may retain the already-serving runtime only
when both origin documents and manifests match the complete original immutable
publisher artifact, all recorded input blobs/modes and watched/glob scopes
remain unchanged, the owning original origin proof passed, and current source
qualification passes. Missing, expired, unsupported or unclassified evidence
uses normal publication. Shared server modules imported by the client are
recorded build inputs; server/\*\* is never a blanket exclusion.

A separate source-bound retained-runtime receipt passes through the existing
post-deploy receiver. Both browser lanes run the whole current protected
assertion and support harness against the actual retained runtime SHA. Runtime
and verification source identities remain separate. Existing cases, cleanup,
engine provenance, all exact release-window gates and the database cutover seal
are preserved. A real runtime/build/control change still builds and publishes
normally, including this initial inventory/control release.

Regression protection builds a real lazy shared-server Vite fixture and checks
complete Git backlog, runtime inputs, unknowns, original artifact byte coverage,
symlinks and exact run/repository/branch receipt provenance. No new publisher,
release freeze, retry loop, certificate equivalence or manual seal is introduced.

The post-Vite Google Fonts inputs are separately recorded inside the sealed artifact with their exact allowlisted URL, fixed request user agent, length and SHA-256. Retention freshly compares every CSS and font byte within a bounded request budget; missing, changed or unavailable external input forces ordinary publication. The Vite graph alone never claims this external-input completeness. Exact-SHA repair/configuration events always publish normally.
