import { describe, expect, it } from 'vitest';
import {
  isEngineCutoverHandshake,
  isEngineHealthUnavailableDiagnostic,
} from '../e2e/support/engineCutoverConsole';

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

describe('engine health diagnostics are separate from cashier errors', () => {
  const text = 'Failed to load resource: the server responded with a status of 503 ()';
  const url = 'https://engine.smarter.poker/health';

  it('classifies only the observed browser resource 503 at the exact HTTPS health endpoint', () => {
    expect(isEngineHealthUnavailableDiagnostic({ text, url })).toBe(true);
  });

  it('keeps other statuses, hosts, paths, methods and application errors critical', () => {
    for (const entry of [
      ...[400, 401, 404, 429, 500, 502, 504].map((status) => ({
        text: text.replace('503', String(status)),
        url,
      })),
      ...[
        'http://engine.smarter.poker/health',
        'https://engine.smarter.poker.evil.example/health',
        'https://engine.smarter.poker/health/extra',
        'https://engine.smarter.poker/health?other=request',
        'https://engine.smarter.poker/action',
        'https://example.supabase.co/rest/v1/rpc/fn_cashier_statement_page',
      ].map((url) => ({ text, url })),
      { text: `POST ${url} 503 (Service Unavailable)`, url },
      { text: 'TypeError: Cashier failed with 503', url },
      { text: `[cashier] ${text}`, url },
      { text, url: '' },
    ]) {
      expect(isEngineHealthUnavailableDiagnostic(entry), JSON.stringify(entry)).toBe(false);
    }
  });
});
