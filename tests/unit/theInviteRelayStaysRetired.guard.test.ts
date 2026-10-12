/**
 * THE OPEN MAIL RELAY MUST NOT COME BACK.
 *
 * `send-invite-email` read `to`, `clubName`, `inviterName`, `inviteUrl` and
 * `inviteCode` from the request body and interpolated all five, UNESCAPED, into
 * an HTML mail sent through Resend as `Club Arena <invites@clubarena.poker>`.
 * It was deployed `verify_jwt: true`, which is not authorisation - the anon key
 * is published in the client bundle and is a valid JWT, so any anonymous
 * visitor passed. Arbitrary HTML, to any recipient, from the brand's own
 * DKIM-signed domain, under the words "Accept Invitation".
 *
 * It is retired rather than authorised because the flow it served is gone:
 * `public.club_invites` does not exist in production, nothing in the repository
 * calls the function, `PlayerInviteModal` already builds a link that redeems
 * through `fn_redeem_club_invite_code`, and it was measured at ZERO invocations
 * in the preceding 24 hours. There is no pending-invite row to derive a safe
 * `clubName`/`inviteUrl`/`inviteCode` from, so there is nothing to authorise.
 *
 * Same shape as `send-push-notification`, retired 2026-08-31 (issue #1498), and
 * as World Hub's `pages/api/notifications/send.js`, closed 2026-07-25. This was
 * the third instance, so the second describe below guards the CLASS rather than
 * this one name: no edge function may interpolate a request-body value into
 * HTML it sends.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const FUNCTIONS = join(ROOT, 'supabase/functions');
const RELAY = join(FUNCTIONS, 'send-invite-email/index.ts');

/** Comments explain the retirement at length; they are not the behaviour. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}

describe('send-invite-email refuses, and cannot quietly start sending again', () => {
  const source = readFileSync(RELAY, 'utf8');
  const code = stripComments(source);

  it('answers 410 and nothing else', () => {
    expect(code).toContain('status: 410');
    expect(code).not.toMatch(/status:\s*(?:200|201|202)\b/);
  });

  it('no longer reaches Resend, or any other transport', () => {
    // NAMING Resend in the 410 body is fine and useful. REACHING it is the
    // thing that must never come back, so the assertion is on the endpoint and
    // on outbound calls, not on the word.
    expect(code, 'the mail endpoint must not reappear').not.toMatch(/api\.resend\.com/i);
    expect(code, 'a retired relay makes no outbound calls').not.toMatch(/\bfetch\s*\(/);
    expect(code, 'a retired relay needs no sending credential').not.toMatch(/RESEND_API_KEY/);
  });

  it('no longer reads a caller-supplied recipient or body', () => {
    // The whole vulnerability in five identifiers plus the sender it borrowed.
    for (const field of ['clubName', 'inviterName', 'inviteUrl', 'inviteCode']) {
      expect(code, `${field} is the shape of the hole that was closed`).not.toContain(field);
    }
    expect(code, 'the request body is not read at all').not.toMatch(/req\.json\s*\(/);
    // NAMING the sender in the 410 body is useful - it says what was being
    // impersonated. SETTING it is what must not come back, so the assertion is
    // on the `from:` field of an outbound payload, not on the address.
    expect(code, 'the brand sender must not be set again').not.toMatch(/\bfrom\s*:\s*['"`]/);
  });

  it('names the path that actually works, so the next reader is not left guessing', () => {
    expect(source).toContain('fn_redeem_club_invite_code');
    expect(source).toContain('#1498');
  });
});

/**
 * THE ONE THAT MATTERS LATER. This is the class, not the name: a function that
 * takes text from its caller and puts it into HTML it sends is a phishing
 * primitive whatever it is called and whoever it mails.
 */
describe('no edge function interpolates a request-body value into HTML', () => {
  it('holds for every function in the repo', () => {
    if (!existsSync(FUNCTIONS)) return;
    const offenders: string[] = [];
    for (const dir of readdirSync(FUNCTIONS)) {
      const entry = join(FUNCTIONS, dir, 'index.ts');
      if (!existsSync(entry)) continue;
      const body = stripComments(readFileSync(entry, 'utf8'));

      // Does it read its caller's body at all? If not, there is nothing
      // caller-supplied to interpolate and the function is not in this class.
      if (!/req\.json\s*\(|request\.json\s*\(/.test(body)) continue;

      // Does it build an HTML payload with an interpolation in it? Match the
      // `html:` property value through to the end of its template literal, so
      // a long mail body is read whole rather than through a fixed window.
      for (const m of body.matchAll(/\bhtml\s*:\s*`([\s\S]*?)`/gi)) {
        const template = m[1];
        if (!/\$\{/.test(template)) continue;
        // An interpolation of an ESCAPED value is the correct way to build
        // mail. Only an unescaped one is the hole.
        const unescaped = [...template.matchAll(/\$\{([^}]*)\}/g)]
          .map((i) => i[1].trim())
          .filter((expr) => !/\bescapeHtml\b|\bescapeHTML\b|\bhtmlEscape\b/i.test(expr));
        if (unescaped.length > 0) {
          offenders.push(`${dir}: \${${unescaped.join('}, ${')}}`);
        }
      }
    }
    expect(
      offenders,
      'these edge functions interpolate a value into HTML they send without escaping it. ' +
        'If the value came from the request body, any caller who can reach the function - ' +
        'and the published anon key reaches every function deployed with verify_jwt - can ' +
        "put arbitrary markup and arbitrary links into mail sent from the platform's own " +
        'verified domain. Derive the value server-side from a row the caller is authorised ' +
        'to use, and HTML-escape every interpolation:\n' +
        offenders.join('\n')
    ).toEqual([]);
  });
});
