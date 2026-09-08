# Reject malformed settlement inputs before changing their meaning

The original wrapper coerced NaN, missing amounts and other invalid values into zero and returned success without an RPC. It truncated a fractional finishing place and sent the resulting different place to the database. It also allowed nonfinite amounts to reach serialization.

Validate the numeric input and PostgreSQL integer place before constructing RPC arguments. Malformed input returns invalid_input, remains unconfirmed, reports through the existing error reporter and sends no payment RPC. Explicit zero retains its existing no-op behavior and does not certify an outstanding obligation. Existing positive-amount cent rounding is preserved; complete caller precision and SQL input-boundary validation remain separate audit items.

The baseline failed 23 of 26 executable cases. All 26 pass after the correction, and the four settlement suites pass 50 tests. Server TypeScript passes. No database definition, wallet, historical obligation or recovery mechanism is changed.
