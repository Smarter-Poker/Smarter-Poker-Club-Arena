# Satellite completion requires readable evidence and full cash settlement

The original award method returned normally after target/finisher read errors or cash refusal, and accepted partial cash receipts. Its caller could then finish the tournament and display a full award.

These failure paths now throw into the existing finish exception boundary. Cash awards require confirmed full cumulative settlement before prize stamping. No new recovery or payment mechanism is added. The existing generic satellite recovery still needs complete-award evidence and atomic funding; this correction does not certify those separate requirements.

Six additional cases failed before correction. They exercise the actual award method with substituted external responses, retaining confirmed cash replay and seat cases.

All nineteen focused cases, server TypeScript and all 6,591 server tests across 465 files pass.
