# Throwable Picker Response Ownership

A pending use response could invoke the old selection callback or show an old-account error after the picker switched accounts. The picker now checks intent ownership again after the use request resolves.

Two regression cases reproduced success and failure leaking into the replacement UI before the fix. All 32 focused selector, service and approved-delivery tests pass afterward, as do TypeScript and the production build. The charge receipt remains server-owned; this change does not refund or repeat consumption.

Catalogue completion is still pending. The previously merged ten-item batch is present in production, and all 371 published artwork and sound files checked matched repository SHA256 bytes.
