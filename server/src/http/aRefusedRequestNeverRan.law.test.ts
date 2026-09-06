/**
 * LAW: A REFUSED REQUEST NEVER RAN (Realtime Phase 3 audit, 2026-09-05)
 *
 * `GameServerAPI.engineFetch` retries EVERY engine call once on a 401, after
 * refreshing the session. Nineteen endpoints ride on that retry and several of
 * them move real money: `/addchips` tops a stack up, `/rabbit-hunt` is paid
 * for, `/insurance` buys cover, `/post-bb` posts a blind, `/action` raises.
 *
 * The retry is safe for exactly one reason, and it is a reason about somebody
 * else's code: **a 401 from this engine means the request was refused before
 * anything happened.** Every handler calls `authenticateRequest` first and
 * returns 401 before it touches an engine, a table or the database, so
 * replaying is free.
 *
 * Nothing pinned that. It was a sentence in a comment in the browser, about
 * the shape of twenty-one call sites in the server - and the day one handler
 * returns 401 AFTER doing work (a per-table permission check moved below a
 * mutation, an ownership test that reads a row first), `engineFetch` silently
 * does that work twice. On `/addchips` that is a doubled top-up; on
 * `/rabbit-hunt` a double charge. Nobody would connect the two files.
 *
 * The Phase 3 idempotency key covers `/action` specifically. This covers the
 * assumption underneath the other eighteen.
 *
 * PINS
 *   1. In every engine handler, a 401 is returned before ANY state is touched
 *      - no engine lookup, no database call, no mutation.
 *   2. Every handler that answers 401 gets it from `authenticateRequest`, not
 *      from its own reasoning about the request.
 *   3. The client retries a 401 exactly once, and retries NOTHING else. A
 *      retry ladder over other statuses would have no such guarantee.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { blankNonCode } from '../testHelpers/sourceWindow.js';

const ROOT = join(__dirname, '..', '..', '..');
const HANDLER_DIR = join(ROOT, 'server', 'src', 'handlers');

/**
 * Anything whose presence before a 401 would mean the request had already
 * begun to act. `readBody` and `JSON.parse` are deliberately NOT here: reading
 * the request is not touching the platform.
 */
const STATE_TOUCHES = ['deps.gameServer', 'getTableEngine(', 'engine.', 'supabase', 'gameServer.'];

function handlerFiles(): string[] {
  return readdirSync(HANDLER_DIR)
    .filter((f) => f.endsWith('.ts') && !f.includes('.test.') && !f.startsWith('_'))
    .sort();
}

/** Every exported function in a handler file, as [name, body]. */
function exportedFunctions(src: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const re = /export (?:async )?function (\w+)/g;
  let m: RegExpExecArray | null;
  const starts: Array<[string, number]> = [];
  while ((m = re.exec(src))) starts.push([m[1], m.index]);
  for (let i = 0; i < starts.length; i++) {
    const [name, at] = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1][1] : src.length;
    out.push([name, src.slice(at, end)]);
  }
  return out;
}

describe('LAW 1/2 - a 401 is refused before anything happens', () => {
  const files = handlerFiles();

  it('there are handlers to check, so a rename cannot make this pass by finding nothing', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it.each(files)('%s refuses before it acts', (file) => {
    const src = readFileSync(join(HANDLER_DIR, file), 'utf8');
    for (const [name, body] of exportedFunctions(src)) {
      const code = blankNonCode(body);
      const at = code.search(/,\s*401,/);
      if (at < 0) continue;
      const before = code.slice(0, at);
      const touched = STATE_TOUCHES.filter((n) => before.includes(n));
      expect(
        touched,
        `${file}:${name} touches ${touched.join(', ')} BEFORE returning 401. ` +
          `GameServerAPI.engineFetch replays every 401 once, so whatever ran ` +
          `first will run twice - on /addchips or /rabbit-hunt that is real ` +
          `money. Move the auth check above it, or stop retrying that route.`
      ).toEqual([]);
      /* And the refusal is a CREDENTIAL's answer, not business logic's.
         Three shapes are legitimate and all three are a credential check made
         before the request begins: the player token (`authenticateRequest`),
         the internal key (`verifyInternalKey`), and the drill route's own
         header token - `faultInjection` is gated on FAULT_INJECTION_TOKEN and
         an exact `x-fault-token` match, never reaches a browser, and would
         fail a narrower pin for no reason. A 401 that came from anything else
         would be business logic wearing an auth status code, and `engineFetch`
         would replay whatever produced it. */
      const credential =
        before.includes('authenticateRequest') ||
        before.includes('verifyInternalKey') ||
        before.includes('req.headers[');
      expect(
        credential,
        `${file}:${name} returns 401 without having checked a credential first`
      ).toBe(true);
    }
  });
});

describe('LAW 3 - the client retries a 401 once, and nothing else', () => {
  const client = readFileSync(join(ROOT, 'src', 'services', 'GameServerAPI.ts'), 'utf8');
  const fnStart = client.indexOf('async function engineFetch(');
  const fn = blankNonCode(client.slice(fnStart, client.indexOf('\n}', fnStart)));

  it('returns immediately for every status that is not 401', () => {
    expect(fn).toContain('if (resp.status !== 401) return resp');
  });

  it('retries at most once - there is no loop in it', () => {
    expect(fn).not.toMatch(/\b(for|while)\s*\(/);
    // Exactly two fetches: the original and the one retry.
    expect((fn.match(/fetch\(url/g) ?? []).length).toBe(2);
  });

  it('the money routes that depend on this are named, so the stake is legible', () => {
    for (const route of ['/addchips', '/rabbit-hunt', '/insurance', '/post-bb', '/action']) {
      expect(client, `${route} should still go through engineFetch`).toContain(
        `\${GAME_SERVER_URL}${route}`
      );
    }
  });
});
