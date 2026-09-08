# Validate settlement inputs before accepting an obligation

The live database settlement accepted a missing amount as a fully settled replay. The engine wrapper is not the only SQL caller, so its input correction cannot protect the database boundary by itself.

The original SQL function now refuses null/nonfinite amounts, checks a negative amount before rounding can erase its sign, and refuses nonpositive place keys. Positive cent rounding and existing settlement behavior are preserved. This adds no wallet writer or recovery process.

Candidate and installed-function probes passed 25 cases: ten input cases plus fifteen paid-owner refusal/replay/top-up cases. Fixtures are temporary and abort within one call; escrow and credit helpers are mocked. Installed migration 20260908011408 has definition MD5 528666ae44da3be2520fa5af6b0a8257. Anonymous and authenticated execution remain denied. The first DDL attempt failed on a statement terminator and left the original hash unchanged; the corrected guarded transaction succeeded.

Production concurrency, full caller precision, historical corrections and full-platform certification remain open.
