import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

const PAGE = readFileSync(resolve(__dirname, '../src/pages/PlayerStatsPage.tsx'), 'utf8');
const HEADLINE_DECK = readFileSync(
  resolve(__dirname, '../src/pages/stats/StatsHeadlineDeck.tsx'),
  'utf8'
);
const CSS = readFileSync(resolve(__dirname, '../src/pages/PlayerStatsPage.css'), 'utf8');
const NEMESIS_CSS = readFileSync(
  resolve(__dirname, '../src/components/stats/NemesisPanel.css'),
  'utf8'
);
const RADAR_CSS = readFileSync(
  resolve(__dirname, '../src/components/stats/PositionalRadar.css'),
  'utf8'
);
const HEATMAP_CSS = readFileSync(
  resolve(__dirname, '../src/components/stats/HoleCardHeatmap.css'),
  'utf8'
);
const TROPHY_CSS = readFileSync(
  resolve(__dirname, '../src/components/stats/TrophyRoom.css'),
  'utf8'
);
const SESSION_CSS = readFileSync(
  resolve(__dirname, '../src/components/stats/SessionHistory.css'),
  'utf8'
);
const FINANCIAL_CSS = readFileSync(
  resolve(__dirname, '../src/components/stats/FinancialReportingPanel.css'),
  'utf8'
);
const POST_DEPLOY_WORKFLOW = readFileSync(
  resolve(__dirname, '../.github/workflows/post-deploy-e2e.yml'),
  'utf8'
);

describe('Stats operational transparency', () => {
  it('measures the authenticated RPC without recording player identity', () => {
    expect(PAGE).toContain("capture('stats_rpc_load'");
    expect(PAGE).toContain('duration_ms');
    expect(PAGE).toContain('payload_bytes');
    expect(PAGE).not.toMatch(/capture\('stats_rpc_load',[\s\S]{0,400}(?:user_id|targetUserId)/);
  });

  it('shows when the readout was loaded and whether it came from cache', () => {
    expect(HEADLINE_DECK).toContain('stats-last-updated');
    expect(PAGE).toContain('lastUpdatedAt');
    expect(PAGE).toContain('statsDataSource');
  });
});

describe('Stats mobile fold budget', () => {
  it('keeps the phone hero compact and turns the evidence cards into a snap rail', () => {
    const phone = CSS.slice(CSS.lastIndexOf('@media (max-width: 390px)'));
    // Dan 2026-10-17: the deck is only its live controls now, so it sizes to
    // them. No fixed floor anywhere, and no hero art or eyebrow left.
    expect(CSS).not.toMatch(/\.stats-command-deck\s*\{[^}]*min-height:/);
    expect(CSS).not.toContain('.stats-hero-art');
    expect(CSS).not.toContain('.stats-eyebrow');
    expect(HEADLINE_DECK).not.toContain('<h1');
    expect(phone).toMatch(/\.stats-brief-grid\s*\{[\s\S]{0,220}grid-auto-flow:\s*column/);
    expect(phone).toMatch(/scroll-snap-type:\s*x mandatory/);
    expect(phone).not.toMatch(
      /\.stats-brief-actions\s*\{[\s\S]{0,100}grid-template-columns:\s*minmax\(0,\s*1fr\)/
    );
  });

  it('keeps every club-scope control on the 44px touch floor', () => {
    expect(CSS).toMatch(
      /\.stats-club-selector button,\s*\.stats-club-sort button,\s*\.stats-club-actions button,\s*\.stats-club-table th button\s*\{[^}]*min-height:\s*44px/
    );
  });

  it('keeps the authoritative time-range controls on the 44px touch floor', () => {
    expect(CSS).toMatch(
      /\.stats-range-row button\s*\{\s*min-width:\s*72px;[^}]*min-height:\s*44px/
    );
  });

  it('keeps hand-evidence rows and the rival expansion on the 44px touch floor', () => {
    expect(CSS).toMatch(/\.stats-evidence-row\s*\{[^}]*min-height:\s*44px/);
    expect(NEMESIS_CSS).toMatch(/\.nemesis-expand\s*\{[^}]*min-height:\s*44px/);
  });

  it('keeps alternate and failure-state actions on the 44px touch floor', () => {
    expect(CSS).toMatch(/\.stats-evidence-action\s*\{[^}]*min-height:\s*44px/);
    expect(CSS).toMatch(/\.hand-retry\s*\{[^}]*min-height:\s*44px/);
    expect(CSS).toMatch(/\.panel-boundary-retry\s*\{[^}]*min-height:\s*44px/);
  });

  it('keeps every live chart, ledger and session control on the touch floor', () => {
    expect(RADAR_CSS).toMatch(/\.pos-radar-toggle\s*\{[^}]*min-height:\s*44px/);
    expect(HEATMAP_CSS).toMatch(/\.heatmap-mode\s*\{[^}]*min-height:\s*44px/);
    expect(HEATMAP_CSS).toMatch(/\.heatmap-select\s*\{[^}]*min-height:\s*44px/);
    expect(HEATMAP_CSS).toMatch(/\.heatmap-drill-close\s*\{[^}]*min-height:\s*44px/);
    expect(TROPHY_CSS).toMatch(/\.trophy-evidence-row\s*\{[^}]*min-height:\s*44px/);
    expect(SESSION_CSS).toMatch(/\.session-expand\s*\{[^}]*min-height:\s*44px/);
    expect(FINANCIAL_CSS).toMatch(/\.financial-receipts summary\s*\{[^}]*min-height:\s*44px/);
    expect(FINANCIAL_CSS).toMatch(/\.financial-console button\s*\{[^}]*min-height:\s*44px/);
  });
});

describe('Stats evidence links to real hand history', () => {
  it('never sends a hand-history action to the member sessions page', () => {
    expect(PAGE).not.toContain("navigate('/player-sessions')");
    expect(PAGE).toContain('buildStatsCashEvidencePath(metric');
    expect(PAGE).toContain('openHandEvidence');
  });
});

describe('Stats production certification', () => {
  it('runs the deep, mobile, and accessibility suite after every successful deploy', () => {
    // The separate fixed one-case recovery must not replace the full deployed-page lane.
    const production = parse(POST_DEPLOY_WORKFLOW).jobs['production-e2e'];
    const commands = production.steps.map((step: { run?: string }) => step.run ?? '').join('\n');
    expect(production.needs).toBe('publication-gate');
    expect(production.if).toContain("needs.publication-gate.outputs.should_run == 'true'");
    const statsGate = commands.indexOf('tests/e2e/stats-deep.spec.ts');
    const broadSweep = commands.indexOf('tests/e2e/smoke.spec.ts');
    expect(statsGate).toBeGreaterThan(-1);
    expect(broadSweep).toBeGreaterThan(statsGate);
    expect(commands.match(/tests\/e2e\/stats-deep\.spec\.ts/g)).toHaveLength(1);
  });
});
