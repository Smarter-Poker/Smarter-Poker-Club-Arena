import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..');
const SCREEN = readFileSync(
  resolve(ROOT, 'src/components/table/TournamentBreakScreen.tsx'),
  'utf8'
);
const CSS = readFileSync(resolve(ROOT, 'src/components/table/TournamentBreakScreen.css'), 'utf8');

const PAGE = readFileSync(resolve(ROOT, 'src/pages/TablePage.tsx'), 'utf8');
const MODALS = readFileSync(resolve(ROOT, 'src/components/table/TableModalsLayer.tsx'), 'utf8');

describe('tournament break console', () => {
  it('keeps the live clock, next level, field, hero, and five leaders connected', () => {
    expect(SCREEN).toContain('breakEndsAtMs - serverNow()');
    expect(SCREEN).toContain('Coming Next: Level {currentLevel + 1}');
    expect(SCREEN).toContain('playersRemainingProp ?? currentFacts?.playersRemaining');
    expect(SCREEN).toContain('averageStackProp ?? currentFacts?.averageStack');
    expect(SCREEN).toContain('prizePoolProp ?? currentFacts?.prizePool');
    expect(SCREEN).toContain('{myPlayer && (');
    expect(SCREEN).toContain('topPlayers.slice(0, 5).map');
  });

  it('uses one approved console instead of slicing multiple unrelated frames', () => {
    expect(SCREEN).toContain('<SpadeConsole');
    expect(SCREEN).toContain('foot="foot"');
    expect(SCREEN).toContain('onClose={() => setMinimized(true)}');
    expect(CSS).not.toContain('border-image');
    expect(CSS).not.toContain('clip-path');
    expect(CSS).not.toContain('club-utility-shell');
    expect(CSS).not.toContain('club-nav-shell');
  });

  it('keeps the complete frame fixed while only its glass scrolls on short screens', () => {
    expect(CSS).toMatch(
      /\.break-screen__content > \.sc__body\s*\{[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto/s
    );
    expect(CSS).toMatch(
      /\.break-screen__content > \.sc__head,[\s\S]*?\.break-screen__content > \.sc__foot\s*\{[^}]*flex-shrink:\s*0/s
    );
    expect(CSS).toMatch(
      /\.break-screen\s*\{[^}]*pointer-events:\s*none;[^}]*background:\s*transparent/s
    );
    expect(SCREEN).toContain('aria-modal="false"');
    expect(CSS).toContain('@media (max-height: 500px)');
    expect(CSS).toMatch(
      /\.break-screen__minimized--on-table\s*\{[^}]*position:\s*absolute;[^}]*top:\s*65%/s
    );
    expect(CSS).toContain('calc(var(--bottom-nav-clearance, 44px) + 12px)');
    expect(CSS).toContain('spade-console-v2/bottom-foot.png');
    expect(CSS).toContain('width: min(240px, 56%)');
    expect(SCREEN).toContain('createPortal(button, tableAnchor)');
    expect(PAGE).toContain('tableAnchorRef={tableScalerRef}');
    expect(MODALS).toContain('tableAnchorRef={tableAnchorRef}');
  });
});
