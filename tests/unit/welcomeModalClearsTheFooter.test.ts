/**
 * The first-run Club Arena acknowledgement must sit ABOVE the bottom nav.
 *
 * Dan, 2026-10-05, with a screenshot of the footer covering the
 * "I Understand And Agree To These Terms" box: "THE FOOTER IS BLOCKING USERS
 * FROM FINISHING AND CLICKING THE AGREEMENT."
 *
 * Cause: the welcome overlay and ClubBottomNav's `.bottomNav` were both
 * `z-index: 1000`, and the nav mounts after <Routes> in App.tsx, so on the tie
 * the footer painted over the console's last rows. A player could not reach
 * the agree box or ENTER and could not get into the arena at all.
 *
 * Fix: the modal portals into <body> (so no ancestor stacking context can trap
 * it) at a layer strictly above the footer and strictly below
 * CompleteProfileModal, which must still open over it.
 *
 * Static read on purpose: jsdom has no layout or stacking, so the honest pin
 * is the declarations that decide the paint order.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

function zIndexOf(css: string, selector: string): number {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const block = css.match(new RegExp(`(^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  expect(block, `${selector} rule not found`).not.toBeNull();
  const z = block![2].match(/z-index:\s*(\d+)/);
  expect(z, `${selector} declares no z-index`).not.toBeNull();
  return Number(z![1]);
}

describe('the welcome acknowledgement clears the footer', () => {
  const welcomeCss = read('src/components/modals/ClubArenaWelcomeModal.module.css');
  const welcomeTsx = read('src/components/modals/ClubArenaWelcomeModal.tsx');
  const footer = zIndexOf(read('src/components/club/ClubBottomNav.module.css'), '.bottomNav');
  const profile = zIndexOf(
    read('src/components/modals/CompleteProfileModal.module.css'),
    '.overlay'
  );
  const welcome = zIndexOf(welcomeCss, '.overlay');

  it('paints above the bottom nav, never tied with it', () => {
    expect(welcome).toBeGreaterThan(footer);
  });

  it('stays below the profile gate so that one still opens over it', () => {
    expect(welcome).toBeLessThan(profile);
  });

  it('renders into <body>, out of any ancestor stacking context', () => {
    expect(welcomeTsx).toMatch(/import \{ createPortal \} from 'react-dom'/);
    expect(welcomeTsx).toMatch(/createPortal\([\s\S]*?document\.body\s*\)/);
  });
});
