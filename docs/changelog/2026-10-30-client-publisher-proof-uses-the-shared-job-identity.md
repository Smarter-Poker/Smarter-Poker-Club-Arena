# Client publication proof follows the existing nested publisher

Publisher 41071586827 successfully installed 299c1a09 at both public origins.
Post-deploy verification 41072696325 then stopped before browser tests because
its inline job-name reader recognized only the old root and `production /`
names. The real writer was `client-publication / production / publish-to-origin`.

The gate now uses the existing shared publisher identity reader, which already
recognizes the exact nested client writer and retained-runtime names. Existing
gateway role names retain their prior exact matching. Current nested read-only
preparation is also recognized when a cancelled run never opened a transaction.

Foreign prefixes, multiple logical origin jobs, incomplete retention proofs,
failed preparation, and transaction callers that started still refuse. Original
publisher receipt ownership, artifact provenance, origin checks, browser tests,
engine interoperability and cleanup requirements are unchanged. No publisher,
retry, timer, release loop or alternate certification route is added.

The executed gate regressions reproduce the nested publication, retention,
ambiguous writer and cancelled-preparation failures before the correction.
Publication and affected live verification remain separate completion evidence.
