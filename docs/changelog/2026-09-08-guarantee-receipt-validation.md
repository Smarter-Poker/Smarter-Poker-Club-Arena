# A guarantee receipt must contain a real chip amount

The original method converted null, booleans and empty strings to a zero pool and marked local finalization complete. Negative, sub-cent and nondecimal numeric values could also pass its finite-number check.

Require an explicit number or decimal string representing nonnegative, safe whole cents before updating the cached pool and finalization flag. Explicit zero remains valid. This does not infer a funded pool from a local guarantee or add a funding fallback.

An executable test extracts the actual production method. Eleven of nineteen receipt cases failed before correction; all nineteen pass after correction, along with four add-on finalization cases. Server TypeScript passes. The first full run failed an existing source-expression guard; preserving that conversion expression while validating its input resolved it, and the full rerun passed all 6,540 tests across 461 files. Live deployment and complete promise-to-bank verification remain open.
