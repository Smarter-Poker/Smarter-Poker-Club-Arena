# Cashier totals certification retains its actual server verdict

The production Statements check allowed the truthful Unavailable fallback to pass, so a green case alone could not prove the optimized totals request succeeded. The existing authorized branch now requires the observed totals response to be HTTP 200, authorized for the same scope, contain valid totals and render four figures. Its attachment records only status, authorization, scope and shape validity, without financial amounts, rows or identity data.

The refused-page branch and application error handling remain unchanged. This observes the existing browser request; it adds no RPC, financial action, role grant, fixture, timeout increase or production retry. Local HTTP fixtures reproduce the 500 timeout rejection and healthy 200 acceptance, with malformed, denied, missing and mismatched-scope negative controls. A successful future production run must still be read with its exact publication and cleanup evidence.
