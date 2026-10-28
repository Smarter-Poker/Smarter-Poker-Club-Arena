# Edit A Member Credit Line Without Changing Their Role

The member record now offers Edit Credit Line for an existing agent agreement. Club owners, co-owners and admins can load the saved funding option and limit, choose Prepaid or Credit Line, and save a new amount without promoting or demoting the member or changing their rakeback.

The editor uses the existing authorized, audited fn_admin_update_agent credit path and sends no role or rate arguments. The server retains its agreement lock, parent-limit and outstanding-debt checks. No chips move. A refused or unconfirmed save requires reloading authoritative terms; duplicate clicks and stale responses are guarded. Component tests cover persisted terms, both funding choices, invalid limits, debt, refusals, receipt identity, and repeated actions.
