import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const PANEL = readFileSync('src/components/agent/DownlineRakePanel.tsx', 'utf8');
const CSS = readFileSync('src/components/agent/DownlineRakePanel.css', 'utf8');

describe('Downline Rake visual authority', () => {
  it('keeps the Stats instrument treatment out of generic inline cards and pills', () => {
    expect(PANEL).toContain("import './DownlineRakePanel.css'");
    expect(PANEL).not.toContain('style={{');
    expect(CSS).not.toMatch(/border-radius:\s*(?:8|10|12|14|16|999)px/);
    expect(CSS).not.toContain('backdrop-filter');
  });

  it('uses semantic controls without primitive status or breadcrumb glyphs', () => {
    expect(PANEL).toContain('className="dlr-member-action"');
    expect(PANEL).toContain('type="button"');
    expect(PANEL).toContain('Verified 30-Second Poll / Last Checked');
    expect(PANEL).not.toContain('Live · Updated');
    expect(PANEL).not.toMatch(/[♠♥♦♣▲▼▪✓✗○★☆⚠→←↑↓›]/u);
  });
});
