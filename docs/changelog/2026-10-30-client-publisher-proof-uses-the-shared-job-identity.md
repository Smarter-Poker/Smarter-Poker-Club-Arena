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

The normal push also exposed load-sensitive guard fixtures. The entry-offset
case now gives its clock and deadline the same fixed instant, so Node startup
cannot turn the rejected 41-second case into an accepted 40-second case. The
real estate-audit fixtures exceeded their 20-second test budgets at 24.3 seconds
in the 321-file suite. Their children now have a finite 45-second bound and a
60-second outer test budget, including reporting and cleanup time. Assertions
and production release deadlines are unchanged. A child process error or signal
throws before any partial report can be used as a passing assertion.
