# Cashier defers global shell adoption

The global shell-update gate could still reload Simple, Classic and Statements Cashier routes after their own background readers had been removed. A newer shell discovered by a service-worker event or focus/idle probe was treated as safe to adopt on a financial form, losing entered amounts.

All routed Cashier pages now refuse automatic shell adoption through the existing central gate, including its checks before and after worker handover. Pending updates remain available after navigation away. Table protection, update discovery and ordinary non-Cashier adoption remain intact. Authentication/account retirement remains intact.

The focused regression fails before the repair: five routed Cashier cases allowed reload, and a mounted stale-shell hook attempted worker handover. The same cases pass after the gate correction; existing ordinary-page and table behavior remains covered. No money mutation, engine change or database migration is included.

Protected main also lacked the TypeScript declaration for its existing Messenger actor-bound request module. The missing declaration caused TS7016 during the required local compiler check. A matching declaration restores that check without changing Messenger runtime behavior.
