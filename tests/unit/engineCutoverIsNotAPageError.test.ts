import { describe, expect, it } from 'vitest';
import { isEngineCutoverHandshake } from '../e2e/support/engineCutoverConsole';

describe('an engine cutover is not a cashier page error', () => {
  it('sets aside only the gateway refusing the engine channel upgrade during a replacement', () => {
    for (const code of ['502', '503']) {
      expect(
        isEngineCutoverHandshake(
          "WebSocket connection to 'wss://engine.smarter.poker/ws/channel?v=1' failed: " +
            'Error during WebSocket handshake: Unexpected response code: ' +
            code
        )
      ).toBe(true);
    }
  });

  it('still fails every other console error', () => {
    for (const text of [
      // Another status is not a cutover.
      "WebSocket connection to 'wss://engine.smarter.poker/ws/channel?v=1' failed: Error during WebSocket handshake: Unexpected response code: 500",
      "WebSocket connection to 'wss://engine.smarter.poker/ws/channel?v=1' failed: Error during WebSocket handshake: Unexpected response code: 401",
      // Another host or path is not the engine channel.
      "WebSocket connection to 'wss://kuklfnapbkmacvwxktbh.supabase.co/realtime/v1/websocket' failed: Error during WebSocket handshake: Unexpected response code: 502",
      "WebSocket connection to 'wss://engine.smarter.poker/ws/table/abc' failed: Error during WebSocket handshake: Unexpected response code: 502",
      // An application error is never set aside.
      'Failed to load resource: the server responded with a status of 500 ()',
      'TypeError: Cannot read properties of undefined',
    ]) {
      expect(isEngineCutoverHandshake(text), text).toBe(false);
    }
  });
});
