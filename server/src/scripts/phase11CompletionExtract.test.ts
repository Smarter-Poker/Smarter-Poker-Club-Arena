import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';

const serverRoot = fileURLToPath(new URL('../../', import.meta.url));
const RELEASE = 'a'.repeat(40);
const FROM = '2026-10-05T03:02:00Z';
const TO = '2026-10-05T03:50:00Z';
const AT = Date.parse('2026-10-05T03:10:00Z');

describe('P11.3 completion reader, stage 1: one natural decision per turn', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it('prints the first look of a turn and names its DEEP second look (audit 2026-10-05)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'p113-seg-'));
    dirs.push(dir);
    const record = (type: string, at: number, receipt: unknown) => ({
      kind: 'decision',
      eventId: `${type}-${at}`,
      sourceRelease: RELEASE,
      body: JSON.stringify({
        snapshot: {
          type,
          decisionTimeMs: at,
          gameState: { gameVariant: 'plo5', gameMode: 'cash' },
        },
        decision: { action: 'call', omahaVariantPolicy: receipt },
      }),
    });
    const raw = Buffer.from(
      [
        record('DECIDE_FAST', AT, { street: 'river' }),
        record('DECIDE_DEEP', AT + 5, { street: 'river' }),
      ]
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n'
    );
    const file = path.join(dir, `${createHash('sha256').update(raw).digest('hex')}.ndjson.gz`);
    writeFileSync(file, gzipSync(raw));
    utimesSync(file, AT / 1000, AT / 1000);
    const run = spawnSync(
      'python3',
      ['scripts/phase11-completion-extract.py', FROM, TO, RELEASE, 'plo5'],
      {
        cwd: serverRoot,
        encoding: 'utf8',
        env: { ...process.env, PHASE11_EXTRACT_SEGMENT_DIRS: dir },
      }
    );
    expect(run.status, run.stderr).toBe(0);
    const rows = run.stdout
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { eventId: string });
    expect(rows.map((r) => r.eventId)).toEqual([`DECIDE_FAST-${AT}`]);
    expect(JSON.parse(run.stderr)).toEqual({
      excluded_deep_second_look: 1,
      records: 1,
      segments_read: 1,
    });
  });
});
