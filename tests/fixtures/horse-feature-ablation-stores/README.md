# Frozen offline qualification inputs

These two compressed inputs are the platform's existing chart and postflop
stores captured read-only on October 27, 2026. They contain solver policy
matrices, no player histories, cards, credentials or financial rows. They are
outside the engine Docker context and serve offline experiments only.

`manifest.json` pins compressed and uncompressed bytes and the production
hydrators' exact content identities. The consumer rejects path changes,
missing/duplicate stores, changed provenance, oversized archives (8 MiB
compressed / 64 MiB uncompressed), changed bytes or a different hydrated
identity. The actual input counts are 240 chart entries and 7,747 postflop
entries. The active V31 store was empty; no candidate V31 dataset is included.

`capture-receipt.json` and `capture-boundaries.json` retain the fresh before
and after source boundaries, raw-export hashes, maintained validator source
hashes, and the actual route: configured Supabase `execute_sql`, read-only,
then the maintained `phase6c-store-snapshot.mjs --from-rows` validator. Its
embedded snapshot `fetchedVia` field is a hardcoded exporter label; the host
exporter script was not executed. The outer receipt records that distinction.
No historical row-count match is substituted for these freshly recomputed
content digests. A later store change requires new frozen input provenance
and a new protected experiment contract, never silent replacement.
