# Registration approvals belong to the visible event

RegistrationApprovalsPanel retained approval state across tournament navigation. Its member loader checked cancellation, but loadApprovals independently wrote the old event response into the current component. The stale approval list exposed Revoke under the new event and retained the old count while loading.

Give the existing panel state an explicit tournament, club, registration-gate and role identity. Changing that scope unmounts the old state owner, so a late old response cannot overwrite the next event and its pending actions cannot clear the next event's busy state. The existing RLS writes, purchase authority, design and manual refresh remain unchanged. This is a client data-isolation defect, not a cause attributed to the engine stalls.

Two rendered regressions fail before the correction. Both now pass alongside 73 connected overview/reconnect tests (75 total); root TypeScript passes. Hosted checks, protected merge, client publication and live verification remain pending.
