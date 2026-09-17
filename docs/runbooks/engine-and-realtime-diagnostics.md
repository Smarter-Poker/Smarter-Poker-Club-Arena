# Engine and realtime diagnostics

Application errors remain visible through the existing browser console, engine stdout/stderr, `financial_alerts`, Prometheus metrics, and Alertmanager rules. The external error telemetry SDK and source-map uploads are retired. Do not add a replacement paid provider or reactivate the retired integration.

When an engine or realtime alert fires:

1. Preserve the original operation, table or tournament identity, timestamp, and alert details.
2. Read the existing engine logs for the named component and reason, and correlate with the durable financial alert or hand-projection obligation. Preserve the original failure; a log message is not proof of settlement or release.
3. Inspect the corresponding Prometheus metric and existing Alertmanager state. Missing metrics mean unknown, not success.
4. Repair the responsible request, transaction, or state transition through reviewed source and the approved local verification and publication path. Do not hand-mark obligations complete, delete audit rows, add a repair watcher, or use a provider as a release gate.

Existing realtime business behavior, financial alerts, maintenance exclusions, and error escalation remain unchanged. Historical schema objects and incident records are evidence and are not a transport activation path. Removing a deployed environment variable is an operational action separate from this source change.
