import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(__dirname, '../src/pages/BadBeatJackpotPage.tsx'), 'utf8');

describe('#ClubButtons BBJ migration', () => {
  it('renders the live amount through the production hero component', () => {
    expect(source).toContain("import { ArenaJackpotDisplay } from '../components/club-buttons'");
    expect(source).toContain('<ArenaJackpotDisplay');
    expect(source).toContain('(jackpot?.main_balance || 0).toLocaleString()');
  });

  it('preserves the existing realtime refresh path', () => {
    expect(source).toContain("masterBus.subscribeDebounced(\n      'HAND_COMPLETED'");
    expect(source).toContain('loadRef.current');
  });

  it('keeps read failure and no-pool states distinct from a real zero balance', () => {
    expect(source).toContain('if (loadFailed || !jackpot)');
    expect(source).toContain('Could Not Load The Jackpot');
    expect(source).toContain('No Jackpot Pool For This Club Yet');
  });

  it('removes the former generic CSS-only hero markup', () => {
    expect(source).not.toContain('className={`jackpot-display');
    expect(source).not.toContain('className="jackpot-glow"');
  });
});
