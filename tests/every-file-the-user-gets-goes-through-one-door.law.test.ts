/**
 * LAW: one implementation of "hand the user a file", and no hardcoded web
 * base in an asset path.
 *
 * WHY THIS EXISTS. Phase 5 of the store-readiness work fixed
 * `src/utils/downloadCsv.ts` so that inside the app a file goes to the system
 * share sheet - a webview does not honour the `download` attribute and
 * silently produces nothing. That fix was correct and it was not enough:
 * on 2026-09-09 an audit of origin/main found TEN screens that had rolled
 * their own `<a download>` and never went near the helper, including a
 * finance ledger and an audit-log export. Two of them defined a LOCAL
 * function also called `downloadCsv`, so a grep for the helper's name looked
 * clean while the app downloaded nothing.
 *
 * A fixed helper nothing is required to use is not a fix. This is the
 * requirement.
 *
 * Same shape for asset addresses: Vite rewrites a root-relative `/assets/...`
 * in CSS with the build's base, so one source line is correct on the web
 * (/hub/club-arena/assets/...) and in the app (/assets/...). A hardcoded
 * `/hub/club-arena/` prefix is correct on the web and draws nothing in the
 * app, with no error - which is exactly how it survived review.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// The native share sheet is recorded, not run - there is no phone under vitest.
const shareBlob = vi.fn<
  (blob: Blob, filename: string, title?: string, isCurrent?: () => boolean) => Promise<boolean>
>(async () => true);
vi.mock('../src/lib/native/share', () => ({
  nativeShareBlob: (blob: Blob, filename: string, title?: string, isCurrent?: () => boolean) =>
    shareBlob(blob, filename, title, isCurrent),
}));
const native = vi.hoisted(() => ({ writeFile: vi.fn(), share: vi.fn() }));
vi.mock('@capacitor/filesystem', () => ({
  Filesystem: { writeFile: native.writeFile },
  Directory: { Cache: 'CACHE' },
}));
vi.mock('@capacitor/share', () => ({ Share: { share: native.share } }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function pretendNative(on: boolean) {
  const w = window as unknown as { Capacitor?: unknown };
  if (on) w.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios' };
  else delete w.Capacitor;
}

const root = join(__dirname, '..');
const SRC = join(root, 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** The one module allowed to touch the download attribute. */
const THE_DOOR = 'src/utils/downloadCsv.ts';

describe('every file handed to the user goes through one door', () => {
  beforeEach(() => {
    shareBlob.mockReset().mockResolvedValue(true);
    native.writeFile.mockReset().mockResolvedValue({ uri: 'file:///cache/share/ledger.csv' });
    native.share.mockReset().mockResolvedValue({});
  });
  afterEach(() => {
    pretendNative(false);
    vi.restoreAllMocks();
  });

  it('a file that sets a download attribute has handled the app first', () => {
    // The attribute itself is fine as the WEB path. What is not fine is a
    // file whose only path is the attribute, because that file does nothing
    // at all inside the app. So the requirement is: go through the door, or
    // branch on isNativePlatform() yourself before falling back to it.
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (!/\.(ts|tsx)$/.test(file)) continue;
      const rel = relative(root, file);
      if (rel === THE_DOOR) continue;
      const src = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^[ \t]*\/\/.*$/gm, '');
      const setsDownload = /\.download\s*=/.test(src) || /<a[^>]*\sdownload[\s=>]/.test(src);
      if (!setsDownload) continue;
      const handlesNative = /isNativePlatform\(\)/.test(src) && /nativeShareBlob/.test(src);
      if (!handlesNative) offenders.push(rel);
    }
    expect(
      offenders,
      `these set a download attribute with no app path, so they do nothing there.\n` +
        `Use downloadBlob(filename, blob) or downloadCsv(filename, csv) from ${THE_DOOR},\n` +
        `or branch on isNativePlatform() to nativeShareBlob first:\n  ` +
        offenders.join('\n  ')
    ).toEqual([]);
  });

  // The door is exercised, not read: a text pin cannot catch a line that is
  // present and wrong, and src/utils is under the source-grep ratchet.
  it('the door sends the file to the share sheet in the app, and to an anchor on the web', async () => {
    const { downloadBlob, downloadCsv } = await import('../src/utils/downloadCsv');

    // ── in the app ────────────────────────────────────────────────────────
    pretendNative(true);
    const blob = new Blob(['a,b'], { type: 'text/csv' });
    expect(downloadBlob('ledger.csv', blob)).toBe(true);
    await vi.waitFor(() => expect(shareBlob).toHaveBeenCalledTimes(1));
    const [sharedBlob, sharedName] = shareBlob.mock.calls[0] as unknown as [Blob, string];
    expect(sharedName).toBe('ledger.csv');
    expect(sharedBlob).toBe(blob);
    // nothing was handed to the DOM, which would have done nothing there
    expect(document.querySelector('a[download]')).toBeNull();

    // ── on the web ────────────────────────────────────────────────────────
    pretendNative(false);
    shareBlob.mockClear();
    const clicks: string[] = [];
    const realCreate = document.createElement.bind(document);
    const spy = vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const el = realCreate(tag) as HTMLElement;
      if (tag === 'a') el.click = () => clicks.push((el as HTMLAnchorElement).download);
      return el;
    }) as typeof document.createElement);
    try {
      expect(downloadBlob('web.csv', new Blob(['x']))).toBe(true);
      expect(clicks).toEqual(['web.csv']);
      expect(shareBlob).not.toHaveBeenCalled();

      // and downloadCsv delegates rather than re-implementing: same one path,
      // with the BOM Excel needs added on the way through.
      clicks.length = 0;
      expect(downloadCsv('rake.csv', 'a,b')).toBe(true);
      expect(clicks).toEqual(['rake.csv']);
    } finally {
      spy.mockRestore();
    }

    pretendNative(true);
    shareBlob.mockClear();
    expect(downloadCsv('rake.csv', 'a,b')).toBe(true);
    await vi.waitFor(() => expect(shareBlob).toHaveBeenCalledTimes(1));
    const [csvBlob] = shareBlob.mock.calls[0] as unknown as [Blob, string];
    expect(await csvBlob.text()).toBe('\ufeffa,b');
    pretendNative(false);
  });

  it('a guarded native download waits for the share result and propagates refusal', async () => {
    const { downloadBlob } = await import('../src/utils/downloadCsv');
    pretendNative(true);
    const gate = deferred<boolean>();
    shareBlob.mockReturnValueOnce(gate.promise);
    const current = () => true;
    let completed = false;
    const pending = Promise.resolve(downloadBlob('ledger.csv', new Blob(['a,b']), current)).then(
      (result) => {
        completed = true;
        return result;
      }
    );
    await vi.waitFor(() => expect(shareBlob).toHaveBeenCalledOnce());
    expect(shareBlob.mock.calls[0][3]).toBe(current);
    expect(completed).toBe(false);
    gate.resolve(true);
    await expect(pending).resolves.toBe(true);

    shareBlob.mockRejectedValueOnce(new Error('Native Share Refused'));
    await expect(downloadBlob('ledger.csv', new Blob(['a,b']), current)).rejects.toThrow(
      'Native Share Refused'
    );
    expect(document.querySelector('a[download]')).toBeNull();
  });

  it('retires the account during the native helper import before handing it bytes', async () => {
    const { downloadBlob } = await import('../src/utils/downloadCsv');
    pretendNative(true);
    let current = true;
    const pending = downloadBlob('ledger.csv', new Blob(['a,b']), () => current);
    current = false;
    await expect(pending).rejects.toThrow('export_account_or_view_changed');
    expect(shareBlob).not.toHaveBeenCalled();
  });

  it.each(['before imports', 'during imports', 'during blob read', 'during cache write'])(
    'the real native helper refuses account retirement %s before OS sharing',
    async (phase) => {
      const { nativeShareBlob } =
        await vi.importActual<typeof import('../src/lib/native/share')>('../src/lib/native/share');
      let current = phase !== 'before imports';
      const readers: FileReader[] = [];
      vi.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementation(function () {
        readers.push(this);
      });
      const write = deferred<{ uri: string }>();
      native.writeFile.mockReturnValueOnce(write.promise);
      const pending = nativeShareBlob(new Blob(['a,b']), 'ledger.csv', undefined, () => current);
      const refused = expect(pending).rejects.toThrow('export_account_or_view_changed');
      if (phase === 'during imports') current = false;
      if (phase === 'during blob read' || phase === 'during cache write') {
        await vi.waitFor(() => expect(readers).toHaveLength(1));
        const reader = readers[0];
        if (phase === 'during blob read') current = false;
        Object.defineProperty(reader, 'result', {
          configurable: true,
          value: 'data:text/csv;base64,YSxi',
        });
        reader.dispatchEvent(new ProgressEvent('load'));
        if (phase === 'during cache write') {
          await vi.waitFor(() => expect(native.writeFile).toHaveBeenCalledOnce());
          current = false;
          write.resolve({ uri: 'file:///cache/share/ledger.csv' });
        }
      }
      await refused;
      expect(native.share).not.toHaveBeenCalled();
      if (phase !== 'during cache write') expect(native.writeFile).not.toHaveBeenCalled();
    }
  );

  it('awaits the actual OS share and does not call a completed handoff cancelled after an account switch', async () => {
    const { nativeShareBlob } =
      await vi.importActual<typeof import('../src/lib/native/share')>('../src/lib/native/share');
    const { downloadBlob } = await import('../src/utils/downloadCsv');
    shareBlob.mockImplementation(nativeShareBlob);
    pretendNative(true);
    let current = true;
    let completed = false;
    const share = deferred<object>();
    native.share.mockReturnValueOnce(share.promise);
    const pending = Promise.resolve(
      downloadBlob('ledger.csv', new Blob(['a,b']), () => current)
    ).then((result) => {
      completed = true;
      return result;
    });
    await vi.waitFor(() =>
      expect(native.share).toHaveBeenCalledWith({
        title: 'ledger.csv',
        files: ['file:///cache/share/ledger.csv'],
      })
    );
    expect(native.writeFile).toHaveBeenCalledWith({
      path: 'share/ledger.csv',
      data: 'YSxi',
      directory: 'CACHE',
      recursive: true,
    });
    expect(completed).toBe(false);
    current = false;
    share.resolve({});
    await expect(pending).resolves.toBe(true);
    expect(native.share).toHaveBeenCalledOnce();
  });

  it.each(['writeFile', 'share'] as const)(
    'propagates the actual native %s refusal',
    async (stage) => {
      const { nativeShareBlob } =
        await vi.importActual<typeof import('../src/lib/native/share')>('../src/lib/native/share');
      native[stage].mockRejectedValueOnce(new Error('Native Permission Refused'));
      await expect(
        nativeShareBlob(new Blob(['a,b']), 'ledger.csv', undefined, () => true)
      ).rejects.toThrow('Native Permission Refused');
      if (stage === 'writeFile') expect(native.share).not.toHaveBeenCalled();
      else expect(native.share).toHaveBeenCalledOnce();
    }
  );
});

describe('no asset address hardcodes the web base', () => {
  it('CSS and TSX use root-relative paths that Vite rewrites per build', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (!/\.(css|ts|tsx)$/.test(file)) continue;
      const rel = relative(root, file);
      const cleaned = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^[ \t]*\/\/.*$/gm, '');
      for (const [i, line] of cleaned.split('\n').entries()) {
        // a real reference, not prose in a comment
        if (/(url\(|src=|href=)\s*['"]?\/hub\/club-arena\//.test(line)) {
          offenders.push(`${rel}:${i + 1}`);
        }
      }
    }
    expect(
      offenders,
      `these name the web sub-path, so they resolve to nothing inside the app.\n` +
        `Drop the /hub/club-arena prefix; Vite adds the build's base:\n  ` +
        offenders.join('\n  ')
    ).toEqual([]);
  });
});
