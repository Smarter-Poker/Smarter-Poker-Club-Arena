import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..');
const SCREEN = readFileSync(
  resolve(ROOT, 'src/components/table/TournamentBreakScreen.tsx'),
  'utf8'
);
const CSS = readFileSync(resolve(ROOT, 'src/components/table/TournamentBreakScreen.css'), 'utf8');

describe('premium tournament break machine', () => {
  it('preserves the live countdown, next level, field stats, player status, and leaders', () => {
    expect(SCREEN).toContain('breakEndsAtMs');
    expect(SCREEN).toContain('setInterval');
    expect(SCREEN).toContain('Coming Next: Level {currentLevel + 1}');
    expect(SCREEN).toContain('{playersRemaining}');
    expect(SCREEN).toContain('{formatStack(averageStack)}');
    expect(SCREEN).toContain('{formatStack(prizePool)}');
    expect(SCREEN).toContain('{myPlayer && (');
    expect(SCREEN).toContain('topPlayers.slice(0, 5).map');
  });

  it('uses an accessible premium dialog with the exact Club Arena chip medallion', () => {
    expect(SCREEN).toContain('role="dialog"');
    expect(SCREEN).toContain('aria-modal="true"');
    expect(SCREEN).toContain('aria-labelledby="break-title"');
    expect(SCREEN).toContain('className="break-screen__medallion"');
    expect(SCREEN).toContain('className="break-screen__close"');
    expect(SCREEN).toContain('aria-label="Close Break Screen"');
    expect(SCREEN).not.toContain('break-screen__minimize-btn');
    expect(CSS).toMatch(/\.break-screen__medallion\s*\{[^}]*z-index:\s*4/s);
    const medallionRule =
      CSS.match(/\.break-screen__medallion\s*\{[^}]*\}/gs)?.find((rule) =>
        rule.includes('lobby-approved-desktop-reference-v3.png')
      ) || '';
    expect(medallionRule).toContain('lobby-approved-desktop-reference-v3.png');
    expect(medallionRule).toContain('-328px -899px /');
    expect(medallionRule).toContain('734px 977px no-repeat');
  });

  it('replaces the flat navy card with black chrome hardware and restrained state colors', () => {
    const premium = CSS.slice(CSS.indexOf('PREMIUM CLUB ARENA BREAK MACHINE'));
    expect(premium).toContain('lobby-header-frame-v3.png');
    expect(premium).toContain('club-nav-shell.webp');
    expect(premium).toContain('club-utility-shell.webp');
    expect(premium).toContain('lobby-selector-default-v3.png');
    expect(premium).toMatch(
      /\.break-screen\s*\{[^}]*linear-gradient\(180deg, #020508 0%, #000 56%, #02060a 100%\)/s
    );
    expect(premium).toMatch(
      /\.break-screen__content\s*\{[^}]*grid-template-columns:\s*repeat\(12,/s
    );
    expect(premium).toMatch(/\.break-screen__stats\s*\{[^}]*grid-template-columns:\s*repeat\(3,/s);
  });

  it('stacks safely on phones and honors reduced motion', () => {
    expect(CSS).toMatch(
      /@media \(max-width: 640px\)[\s\S]*?\.break-screen__timer-container,[\s\S]*?\.break-screen__next-level\s*\{[^}]*grid-column:\s*1 \/ -1/s
    );
    expect(CSS).toMatch(
      /@media \(max-width: 390px\)[\s\S]*?\.break-screen__stats\s*\{[^}]*grid-template-columns:\s*repeat\(2,/s
    );
    expect(CSS).toMatch(
      /@media \(max-width: 390px\)[\s\S]*?\.break-screen__stat:last-child\s*\{[^}]*grid-column:\s*1 \/ -1/s
    );
    const reducedMotion = CSS.slice(CSS.lastIndexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reducedMotion).toContain('.break-screen *');
    expect(reducedMotion).toContain('animation: none !important');
    expect(reducedMotion).toContain('transition: none !important');
  });
});
