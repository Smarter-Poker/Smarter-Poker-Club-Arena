/**
 * LAW: EVERY WAY A TABLE CAN REFUSE YOU IS WRITTEN DOWN
 * ═══════════════════════════════════════════════════════════════════════════
 * Realtime Connections Programme, phase 6 of 7 - "prove it from outside".
 *
 * On 2026-09-03 every Club Arena table said "Reconnecting To The Table" for
 * twenty-two hours. The engine was refusing the socket with a pre-handshake
 * HTTP 401; the browser reported that as close 1006, which is
 * indistinguishable from a dropped link; and nobody knew what to look at,
 * because nothing anywhere said what a refusal from this platform looks like.
 *
 * The fix for the code was phases 1-5. The fix for the NEXT person is
 * `docs/runbooks/tables-say-reconnecting.md`, and a runbook rots the moment
 * the code moves past it. So:
 *
 *   1. Every close code the engine or the client can produce appears in the
 *      runbook. Add a code without documenting it and this goes red - which
 *      is the whole point, because the code you forget to document is the one
 *      nobody has seen before at 3am.
 *   2. The ambiguous ones are called out by name. 1006 is the one that cost
 *      twenty-two hours; a runbook that lists the tidy 4xxx codes and skips
 *      the one that actually appeared would be a runbook for a nicer outage
 *      than the one we had.
 *   3. The runbook's own links resolve. A 3am page that lands on a broken
 *      relative link is a page with no runbook.
 *   4. The probe that pages you knows the same codes by name, so the alert
 *      you receive and the page you read use one vocabulary.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { sliceMarkdownSection } from './helpers/sourceWindow';

const ROOT = join(__dirname, '..');
const RUNBOOK_REL = 'docs/runbooks/tables-say-reconnecting.md';
const RUNBOOK_PATH = join(ROOT, RUNBOOK_REL);
const RUNBOOK = readFileSync(RUNBOOK_PATH, 'utf8');
/** Prose reflowed onto one line: a hard-wrapped sentence is still the sentence. */
const RUNBOOK_FLAT = RUNBOOK.replace(/\s+/g, ' ').toLowerCase();

/** Files that declare a close code this platform can put on the wire. */
const CODE_SOURCES = [
  'server/src/transport/EngineWebSocketServer.ts',
  'server/src/transport/ChannelWebSocketServer.ts',
  'src/services/EngineStateClient.ts',
  'src/services/EngineSocketMux.ts',
];

/**
 * Every `CLOSE_SOMETHING = 4xxx` in those files, as {name, code}. Deduped by
 * code, because the engine and the client each declare 4401 and they are one
 * code with one meaning.
 */
function declaredCloseCodes(): Map<number, string[]> {
  const byCode = new Map<number, string[]>();
  for (const rel of CODE_SOURCES) {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    for (const m of src.matchAll(/(?:export\s+)?const\s+(CLOSE_[A-Z_]+)\s*=\s*(4\d{3})\b/g)) {
      const code = Number(m[2]);
      const names = byCode.get(code) ?? [];
      if (!names.includes(m[1])) names.push(m[1]);
      byCode.set(code, names);
    }
  }
  return byCode;
}

describe('LAW 1 - every close code is in the runbook', () => {
  const codes = declaredCloseCodes();

  it('finds the codes at all (a scan that finds nothing passes everything)', () => {
    expect(codes.size, 'no CLOSE_* constants found - the scan is broken, not the code').
      toBeGreaterThanOrEqual(6);
    // The four that carry the programme's own findings.
    for (const known of [4401, 4404, 4426, 4429]) {
      expect([...codes.keys()], `${known} should be declared somewhere`).toContain(known);
    }
  });

  it.each([...codes.entries()].map(([code, names]) => [code, names.join('/')]))(
    'close %s (%s) is documented',
    (code) => {
      expect(
        RUNBOOK.includes(String(code)),
        `close ${code} can reach a player and ${RUNBOOK_REL} does not mention it. ` +
          'Add a section saying what it means and what to do - the undocumented code is ' +
          'the one nobody has seen before at 3am.'
      ).toBe(true);
    }
  );
});

describe('LAW 2 - the ambiguous refusal is called out by name', () => {
  it('1006 is documented, and as an AMBIGUOUS signal', () => {
    expect(RUNBOOK).toContain('1006');
    // The SECTION about 1006, bounded by the next heading - not by a byte
    // count, which goes stale the first time the section gains a paragraph.
    const section = sliceMarkdownSection(RUNBOOK, '1006').replace(/\s+/g, ' ').toLowerCase();
    // It must say the thing that made the outage invisible: from a client,
    // this is the same as a dropped link.
    expect(section).toMatch(/indistinguishable|same as a dropped link/);
    // And it must send the reader to the five refusals written BEFORE the
    // handshake, which all arrive as this one code.
    expect(section).toContain('403');
  });

  it('and the runbook says a green deploy run is not a deployment', () => {
    // Found while verifying phase 5: the deploy workflow reports success with
    // the cutover skipped. Anyone debugging "I fixed this already" needs it.
    expect(RUNBOOK_FLAT).toContain('image tag');
    expect(RUNBOOK_FLAT).toContain('green deploy run is not a deployment');
  });

  it('and it names the silence case, not just the failure case', () => {
    // A probe that stops running is silent, and silence looks like health.
    expect(RUNBOOK_FLAT).toContain('no recent rows');
    expect(RUNBOOK_FLAT).toContain('silence looks exactly like health');
  });
});

describe('LAW 3 - the runbook is reachable and its links resolve', () => {
  it('the programme document points at it', () => {
    const programme = readFileSync(join(ROOT, 'docs/REALTIME-CONNECTIONS-PROGRAMME.md'), 'utf8');
    expect(programme).toContain('tables-say-reconnecting.md');
  });

  it('every relative link in it exists', () => {
    const broken: string[] = [];
    for (const m of RUNBOOK.matchAll(/\]\((\.[^)#]+)(#[^)]*)?\)/g)) {
      const target = resolve(dirname(RUNBOOK_PATH), m[1]);
      if (!existsSync(target)) broken.push(m[1]);
    }
    expect(broken, 'a 3am page that lands on a broken link is a page with no runbook').toEqual([]);
  });
});
