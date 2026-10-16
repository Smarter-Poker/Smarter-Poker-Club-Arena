# tests/the-sealed-certificate-reader-keeps-its-sealed-body.law.test.ts

The sealed certificate reader keeps its sealed body (2026-10-16): fn_accounting_close_certificate is an md5-sealed inventory proof source, so it is restored to the sealed body (7b4a5f45...) after 20261016123337 broke the seal and nulled the inventory generation, and no later migration may rewrite it without re-sealing original_inventory_proof_sources_match() in the same change.
