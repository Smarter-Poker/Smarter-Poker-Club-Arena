# Native alert intake activates at gateway startup

The installed OpenClaw 2026.6.6 planner leaves a plugin without startup metadata inert. The original receive plugin was discoverable and enabled but absent from gateway startup; its status method and service never registered. Its manifest now explicitly sets activation.onStartup=true. The service code, private database channel, credentials, bounded journal, complete-read acknowledgement, financial permissions and release exclusions are unchanged.

The actual installed startup planner omitted the original manifest and admitted the corrected manifest with the same enabled configuration. The retained native-alert regression checks this required manifest property. Existing registration and service APIs were checked against the installed SDK; both match the component. Protected integration, immutable installation, private subscription and actual event/read/ack proof remain required separately.
