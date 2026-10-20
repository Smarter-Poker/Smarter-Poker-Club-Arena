# Cashier verification retains separate engine health diagnostics

The dedicated Cashier and Statements certificates now attach the raw console entries for the exact HTTPS engine `/health` browser resource HTTP 503 separately from Cashier errors. Run 39329585268 failed its Cashier console assertion on two such shell health observations while the other four Cashier cases passed. This classification does not assert why the engine returned 503.

All other console messages, statuses, hosts and paths retain their existing failure behavior. Engine certification still requires HTTP 200 and liveness. No application, financial, engine runtime or release gate changes.

The maintained shared-helper regression covers the exact observed diagnostic and near misses including other statuses, hosts, paths, method-bearing and application messages. Both dedicated certificates retain their critical-error assertions and raw diagnostic attachments.
