/**
 * Bounded HTTP request body reader.
 *
 * Extracted from `server/src/index.ts` in Phase U3.2 (2026-04-23).
 *
 * FIX 175: enforces a 16 KB body-size limit to prevent memory exhaustion from
 * malicious clients. Any action payload in the poker engine fits easily.
 */

import type { IncomingMessage } from 'http';

export const MAX_BODY_SIZE = 16 * 1024; // 16KB — more than enough for any action payload

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      body += chunk.toString();
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}
