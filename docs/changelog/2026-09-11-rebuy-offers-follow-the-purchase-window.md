# Rebuy offers follow the purchase window

Tournament rebuy and re-entry offers now use the same level fallback as the database purchase window: a zero or absent rebuy-level setting falls back to the late-registration level cap. A configured cap takes priority over a timed window, including at its exact closing level. An unknown current level cannot become level zero through numeric coercion.

The tournament detail read now includes `addon_period_triggered`. Extending the rebuy window through an add-on requires that activation flag and the persisted start/end interval. An activated add-on remains independent of the level window, as it is in `fn_ca_tournament_rebuy_window`.

The change affects the existing Table and Tournament Page eligibility calls. The database still owns the purchase, exact knockout generation, funding, playable seat, and immutable replay receipt. Existing purchase retries do not pass through this mutable eligibility check.

Validation: eight dynamic failures reproduced on the original service before the fix. The final 29 added dynamic cases cover the real detail projection, rebuy/re-entry fallback, explicit and timed caps, add-on activation and boundaries, unknown levels, unpaid/zero-stack entry checks, purchase limits, and eliminated-entry re-entry. Seven focused client, reconnect, and acquisition suites pass 299 tests, including the existing exact purchase replay cases. TypeScript and the production build pass. Native database window qualification is recorded separately by the integration owner; these client checks are not an installed-production certificate.
