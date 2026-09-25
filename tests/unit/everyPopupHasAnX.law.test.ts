/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  EVERY POPUP CARRIES THE CONSOLE'S PAINTED X (Dan 2026-09-23, item B6)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "There needs to be an X in the top right of every popup (BBJ, table
 * settings, etc.)."
 *
 * The X is SpadeConsole's own `onClose` zone, painted per family. A popup is a
 * SpadeConsole rendered under a `role="dialog"` / `role="alertdialog"` element
 * or inside <Modal>. The first pass (cafc6dca) wired 37 of them and missed
 * twenty-two; the review the morning after (2026-09-24) wired the rest and
 * found nine whose X was routed past the surface's own busy guard - a
 * cashout, a union wallet, a chip mint, a tournament create, all closable
 * mid-flight from the corner when their Cancel plate was disabled. So this
 * pins both halves:
 *
 *   1. Every console under a dialog has `onClose`, unless it is named below
 *      with the reason it may not be dismissed.
 *   2. Where the file has a busy flag (`busy`, `saving`, `isSubmitting`,
 *      `isBusy`, `loading`, `submitting`, `purchaseBusy`, `asking`,
 *      `claimingId`, `isProcessing`) that disables a plate on the same
 *      console, the X is gated on it too (`flag ? undefined : handler`) or
 *      goes through a handler whose name says it guards (`requestClose`,
 *      `closeIfIdle`, `cancelPending...`).
 *
 * SpadeConsole hides the X when `onClose` is undefined, which is how a busy
 * surface says "you cannot close this right now" without a disabled control
 * it does not paint.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');

/**
 * Consoles under a dialog that deliberately carry NO X. Each entry is
 * `file:line-of-<SpadeConsole>` with the reason. Adding to this list is a
 * product decision, not a convenience: write the reason.
 */
const NO_X_BY_DESIGN: Record<string, string> = {
  'src/components/legal/TOSAcceptanceModal.tsx':
    'terms must be accepted or declined through the plates; a corner dismiss is neither',
  'src/components/modals/CompleteProfileModal.tsx':
    'the profile is required to play; the only ways out are Save and Skip, both audited',
  'src/components/modals/ClubArenaWelcomeModal.tsx':
    'a legal welcome that is acknowledged once through I Understand, never dismissed',
  'src/components/games/BonusCompletion.tsx':
    'a paid reveal with closeOnOverlay/closeOnEscape false; the plates are the only exits',
  'src/components/games/DoubleDownOffer.tsx':
    'a wager choice with closeOnOverlay/closeOnEscape false; declining is a plate',
  'src/components/tournament/TournamentRankingCard.tsx':
    'carries its own painted close control (.trc2__close) outside the console',
};

const BUSY_FLAGS = [
  'busy',
  'isBusy',
  'saving',
  'isSubmitting',
  'submitting',
  'loading',
  'purchaseBusy',
  'asking',
  'claimingId',
  'isProcessing',
];

type Console = { file: string; line: number; tag: string; before: string };

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== 'node_modules') walk(full, out);
    } else if (name.endsWith('.tsx') && !name.endsWith('.test.tsx')) {
      out.push(relative(ROOT, full));
    }
  }
  return out;
}

function consolesUnderDialogs(): Console[] {
  const out: Console[] = [];
  for (const file of walk(join(ROOT, 'src'))) {
    const src = readFileSync(resolve(ROOT, file), 'utf8');
    const re = /<SpadeConsole\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      let i = m.index + m[0].length;
      let depth = 0;
      while (i < src.length) {
        const c = src[i];
        if (c === '{') depth += 1;
        else if (c === '}') depth -= 1;
        else if (c === '>' && depth === 0) break;
        i += 1;
      }
      const tag = src.slice(m.index, i);
      const before = src.slice(Math.max(0, m.index - 1500), m.index);
      const underDialog =
        /role="(alert)?dialog"/.test(before) ||
        /aria-modal/.test(before) ||
        /<Modal\b/.test(before);
      if (!underDialog) continue;
      out.push({ file, line: src.slice(0, m.index).split('\n').length, tag, before });
    }
  }
  return out;
}

describe('every popup carries the console X (Dan 2026-09-23)', () => {
  const popups = consolesUnderDialogs();

  it('finds the popups', () => {
    expect(popups.length).toBeGreaterThan(50);
  });

  it('every console under a dialog has onClose, or is named here with a reason', () => {
    const missing = popups
      .filter((p) => !/\bonClose=/.test(p.tag) && !NO_X_BY_DESIGN[p.file])
      .map((p) => `${p.file}:${p.line}`);
    expect(missing).toEqual([]);
  });

  it('every entry in the by-design list still exists and still has no X', () => {
    for (const file of Object.keys(NO_X_BY_DESIGN)) {
      const here = popups.filter((p) => p.file === file);
      expect(here.length, `${file} is no longer a popup; remove it from the list`).toBeGreaterThan(
        0
      );
      for (const p of here) {
        expect(
          /\bonClose=/.test(p.tag),
          `${file}:${p.line} now has an X; drop it from the list`
        ).toBe(false);
      }
    }
  });

  it('a console whose plates are disabled while busy gates its X the same way', () => {
    const offenders: string[] = [];
    for (const p of popups) {
      const close = /\bonClose=\{([\s\S]*?)\}\s*(?:\n|\/\*|[a-zA-Z]+=)/.exec(p.tag);
      if (!close) continue;
      const handler = close[1];
      // The plates on this console: `disabled: <flag>` inside the same tag.
      const disabledFlags = BUSY_FLAGS.filter((f) =>
        new RegExp(`disabled:\\s*(?:!\\w+\\s*\\|\\|\\s*)?${f}\\b`).test(p.tag)
      );
      if (disabledFlags.length === 0) continue;
      const gated =
        disabledFlags.some((f) => new RegExp(`${f}\\b[\\s\\S]*\\?\\s*undefined`).test(handler)) ||
        /requestClose|closeIfIdle|cancelPending|handleClose|dismiss\b/.test(handler);
      if (!gated) {
        offenders.push(
          `${p.file}:${p.line}: plates disable on ${disabledFlags.join('/')} but onClose={${handler.trim()}} is not gated on it`
        );
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('the X is never where a trapped dialog starts (2026-09-24)', () => {
  /* Every popup's head comes first in the DOM, so once it carried the X, "the
     first focusable element" on every trapped dialog was the X: Edit Table
     opened on Close instead of Game Name. Both focus mechanisms skip the X
     for initial focus and fall back to it only when it is the only control. */
  it('useFocusTrap and Modal skip .sc__close when choosing initial focus', () => {
    const trap = readFileSync(resolve(ROOT, 'src/hooks/useFocusTrap.ts'), 'utf8');
    const modal = readFileSync(resolve(ROOT, 'src/components/common/Modal.tsx'), 'utf8');
    for (const src of [trap, modal]) {
      expect(src).toMatch(/find\(\(el\) => !el\.classList\.contains\('sc__close'\)\)\s*\?\?/);
    }
  });
});
