/**
 * WHAT THE RENDER REVIEW CAUGHT (2026-09-29).
 *
 * The section redesign shipped with four faults that only a render shows, and
 * every one of them was a selector reaching further than it meant to. These
 * read the stylesheets, because that is where the faults live: a unit test
 * rendering the panel in jsdom sees no computed geometry at all.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

describe('the club message switches keep the kit tick well', () => {
  const css = read('src/components/club/ClubMessageManagementPanel.module.css');

  it('never dresses a checkbox as a text field', () => {
    // The groove rule caught the composer's two switches, and a 21px tick well
    // became a 299px field with its label shoved off the glass.
    const groove = css.match(/\.fields input[^{]*\{[^}]*\}/s)?.[0] ?? '';
    expect(groove).toContain('width: 100%');
    const selector = groove.slice(0, groove.indexOf('{'));
    for (const part of selector.split(',').map((s) => s.trim())) {
      if (part.endsWith('input')) {
        throw new Error(`bare input selector in the groove rule: ${part}`);
      }
    }
    expect(selector).toContain(":not([type='checkbox'])");
  });

  it('gives the description well a whole number of lines', () => {
    const rule = css.match(/\.fields textarea,\s*\.composer textarea \{[^}]*\}/s)?.[0] ?? '';
    expect(rule).toMatch(/height:\s*calc\(4 \* 1\.35em/);
  });

  it('keeps an announcement row of lit words on one line', () => {
    // `.announcementList article > div` is a grid and outranks a bare
    // `.announcementActions`, so each action became its own full-width row.
    const rule =
      css.match(/\.announcementList article > \.announcementActions[^{]*\{[^}]*\}/s)?.[0] ?? '';
    expect(rule).toContain('display: flex');
  });
});

describe('a painted plate is still a 44px target', () => {
  const css = read('src/components/console/SpadeConsole.css');

  it('reaches out to 44px without resizing the art', () => {
    const rule = css.match(/\.sc-plate::after \{[^}]*\}/s)?.[0] ?? '';
    expect(rule).toContain('height: max(100%, 44px)');
    expect(rule).toContain("content: ''");
  });

  it('keeps the close word a word inside a dialog', () => {
    // metallic-popups.css bevels and rounds every dialog button with
    // !important; the plates were already armoured, the close word was not.
    const armour = css.match(/\[role='dialog'\] \.sc__close\.sc__close[\s\S]{0,400}?\}/)?.[0] ?? '';
    expect(armour).toContain('border-radius: 0 !important');
    expect(armour).toContain('background: transparent !important');
  });
});

describe('the ticker customizer draws no browser chrome', () => {
  const css = read('src/components/club/TickerManagementPanel.module.css');

  it('resets the select and the range', () => {
    expect(css).toMatch(/\.customizer select \{[^}]*appearance: none/s);
    expect(css).toMatch(/\.customizer input\[type='range'\] \{[^}]*appearance: none/s);
    expect(css).toMatch(/::-webkit-slider-thumb \{[^}]*border-radius: 0/s);
  });

  it('lines the three colour wells up with each other', () => {
    const rule = css.match(/\.customizer \{[^}]*\}/s)?.[0] ?? '';
    expect(rule).toContain('align-items: end');
  });
});
