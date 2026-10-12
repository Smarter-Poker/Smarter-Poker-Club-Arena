import { afterEach, describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';

const dirs: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'throwable-cue-builder-'));
  dirs.push(root);
  const audio = join(root, 'scripts/audio');
  mkdirSync(audio, { recursive: true });
  mkdirSync(join(root, 'src/throwables'), { recursive: true });
  mkdirSync(join(root, 'public/sounds/throwables'), { recursive: true });
  const script = join(audio, 'build-throwable-cues.mjs');
  copyFileSync(resolve('scripts/audio/build-throwable-cues.mjs'), script);
  const manifest = {
    outputDir: 'public/sounds/throwables',
    allowedLicenses: ['CC0-1.0'],
    sources: {
      own: {
        kind: 'synth',
        license: 'CC0-1.0',
        title: 'Original',
        author: 'Smarter.Poker',
        recipe: 'Synthesized',
      },
    },
    cues: {
      first: { source: 'own', layers: [{ lavfi: 'sine=frequency=440:duration=0.1' }] },
      second: { source: 'own', layers: [{ lavfi: 'sine=frequency=880:duration=0.1' }] },
      reserved: { placeholder: true, fallback: 'pop' },
    },
  };
  writeFileSync(join(audio, 'throwable-cues.manifest.json'), JSON.stringify(manifest));
  const credits = join(root, 'public/sounds/throwables/CREDITS.md');
  writeFileSync(credits, 'Existing credits');
  return {
    root,
    credits,
    run: (...args: string[]) =>
      spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 10000 }),
  };
}
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
describe('partial throwable cue builds', () => {
  it.each([['--only', 'reserved'], ['--only=reserved']])(
    'retains attribution for untouched cues: %s',
    (...args) => {
      // Selecting a placeholder requires no encoder or source downloads. It
      // exercises the same metadata write that previously erased other cues.
      const f = fixture();
      const result = f.run(...args);
      expect(result.status, result.stderr).toBe(0);
      const credits = readFileSync(f.credits, 'utf8');
      expect(credits).toContain('`first`');
      expect(credits).toContain('`second`');
      expect(credits).toContain('`reserved`');
      expect(credits).toContain('sine=frequency=880');
      expect(
        readFileSync(join(f.root, 'src/throwables/cueManifest.generated.ts'), 'utf8')
      ).toContain('"second"');
    }
  );
  it('downloads a single-file OpenGameArt asset only while its page still proves CC0', async () => {
    const f = fixture();
    const payload = Buffer.from('licensed fixture audio');
    const server = createServer((req, res) => {
      if (req.url === '/laugh.ogg') {
        res.writeHead(200, { 'content-type': 'audio/ogg' });
        res.end(payload);
        return;
      }
      const file = `http://127.0.0.1:${(server.address() as any).port}/laugh.ogg`;
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        `<a href="https://creativecommons.org/publicdomain/zero/1.0/">CC0</a><a href="${file}">laugh.ogg</a>`
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const base = `http://127.0.0.1:${(server.address() as any).port}`;
      const manifestPath = join(f.root, 'scripts/audio/throwable-cues.manifest.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      manifest.sources.tinyLaugh = {
        kind: 'opengameart',
        title: 'Tiny Laugh',
        author: 'Fixture Author',
        license: 'CC0-1.0',
        url: `${base}/page`,
        download: `${base}/laugh.ogg`,
        dir: 'tiny-laugh',
      };
      writeFileSync(manifestPath, JSON.stringify(manifest));

      const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
        const child = spawn(
          process.execPath,
          [
            join(f.root, 'scripts/audio/build-throwable-cues.mjs'),
            '--fetch',
            '--only=reserved',
            '--sources',
            join(f.root, 'sources'),
          ],
          { cwd: f.root }
        );
        let stderr = '';
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
        child.on('close', (code) => resolve({ code, stderr }));
      });
      expect(result.code, result.stderr).toBe(0);
      expect(readFileSync(join(f.root, 'sources/tiny-laugh/laugh.ogg'))).toEqual(payload);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it.each(['--only=unknown', '--only='])(
    'rejects invalid selection before overwriting credits: %s',
    (arg) => {
      const f = fixture();
      expect(f.run(arg).status).not.toBe(0);
      expect(readFileSync(f.credits, 'utf8')).toBe('Existing credits');
    }
  );
});
