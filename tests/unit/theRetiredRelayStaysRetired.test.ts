/**
 * THE UNAUTHORISED PUSH RELAY MUST NOT COME BACK (issue #1498).
 *
 * `send-push-notification` read `userIds`, `title`, `message` and `url` from
 * the request body and pushed them, with NO authorisation of any kind, deployed
 * with `verify_jwt: true` - so any signed-in player could aim arbitrary text and
 * an arbitrary link at arbitrary people. It was harmless only because OneSignal
 * was removed on 2026-08-19 and the vendor stopped answering, and "the vendor
 * left" is not a security control.
 *
 * The dangerous repair is the obvious one: somebody fixing "push is broken"
 * repoints this at a working transport and turns a dead relay into a live one,
 * with no authorisation anywhere in the path. That is what this test exists to
 * refuse.
 *
 * Verified against production on 2026-08-31 after the refusal was deployed
 * (version 21): a POST carrying the exact payload shape the old relay accepted
 * returned HTTP 410, and the CORS preflight still returned 200.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const FUNCTIONS = join(ROOT, 'supabase/functions');
const RELAY = join(FUNCTIONS, 'send-push-notification/index.ts');

describe('send-push-notification refuses, and cannot quietly start relaying again', () => {
  const source = readFileSync(RELAY, 'utf8');
  /** Comments explain the retirement at length; they are not the behaviour. */
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));

  it('answers 410 and nothing else', () => {
    expect(code).toContain('status: 410');
    expect(code).not.toMatch(/status:\s*(?:200|201|202)\b/);
  });

  it('no longer reaches the vendor, or any other transport', () => {
    // NAMING OneSignal is fine and useful - the 410 body says what happened and
    // why. REACHING it is the thing that must never come back, so the assertion
    // is on the endpoint and on outbound calls, not on the word.
    expect(code, 'the relay endpoint must not reappear').not.toMatch(/onesignal\.com/i);
    expect(code, 'a retired relay makes no outbound calls').not.toMatch(/\bfetch\s*\(/);
  });

  it('no longer reads a caller-supplied audience', () => {
    // The whole vulnerability in four identifiers.
    for (const field of ['userIds', 'include_external_user_ids', 'imageUrl', 'big_picture']) {
      expect(code, `${field} is the shape of the hole that was closed`).not.toContain(field);
    }
  });

  it('names the path that actually works, so the next reader is not left guessing', () => {
    expect(source).toContain('push_outbox');
    expect(source).toContain('notifications');
  });
});

describe('no other edge function relays push to a vendor', () => {
  it('holds for every function in the repo', () => {
    if (!existsSync(FUNCTIONS)) return;
    const offenders: string[] = [];
    for (const dir of readdirSync(FUNCTIONS)) {
      const entry = join(FUNCTIONS, dir, 'index.ts');
      if (!existsSync(entry)) continue;
      const body = readFileSync(entry, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      // The endpoint, not the name: an explanatory comment may say who it was.
      if (/onesignal\.com/i.test(body)) offenders.push(dir);
    }
    expect(
      offenders,
      `these edge functions still CALL the retired vendor:\n${offenders.join('\n')}`
    ).toEqual([]);
  });
});
