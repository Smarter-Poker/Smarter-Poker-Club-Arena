/**
 * AN ENGINE CUTOVER IS NOT A CASHIER PAGE ERROR (2026-10-15)
 *
 * Post-Deploy E2E run 38672391424 failed "Cashier Page - Financial UI should
 * load without console errors" and the Wallet twin on exactly one line:
 *
 *   WebSocket connection to 'wss://engine.smarter.poker/ws/channel?v=1'
 *   failed: Error during WebSocket handshake: Unexpected response code: 502
 *
 * The run's client browser job overlapped the engine release sealed at
 * 2026-10-15 04:07:06 UTC (ca_engine_deploy_attempts, shipped). While the
 * engine process is replaced the gateway answers the channel upgrade 502/503;
 * the browser itself prints that line (application code cannot suppress or
 * reword it) and the client's channel reconnects on its ladder. The cashier and
 * wallet pages rendered and behaved; what failed was a console filter that
 * counted the browser's own report of a gateway handover as a page error.
 *
 * Only that exact shape is set aside: a handshake to the engine channel that
 * the gateway refused with 502 or 503. Any other WebSocket failure, any other
 * host, any other status and every application error still fails the page.
 * Realtime continuity across an engine replacement is certified by its own
 * suite (production-live-table-realtime), not by these page smoke tests.
 */

const ENGINE_CHANNEL_GATEWAY_REFUSAL =
  /^WebSocket connection to 'wss:\/\/engine\.smarter\.poker\/ws\/channel(?:\?[^']*)?' failed: Error during WebSocket handshake: Unexpected response code: 50[23]$/;

export function isEngineCutoverHandshake(consoleText: string): boolean {
  return ENGINE_CHANNEL_GATEWAY_REFUSAL.test(consoleText.trim());
}
