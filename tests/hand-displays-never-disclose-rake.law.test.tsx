import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import HandDetailView from '../src/components/handdetail/HandDetailView';
import { HandDetailModal } from '../src/components/table/HandDetailModal';
import { encodeHand, decodeHandFromUrl } from '../src/components/table/ShareHand';
import { shareableFromModel } from '../src/lib/shareHandModel';
import { buildReplay, replayInputFromRow } from '../src/utils/handReplay';
import { toPokerStarsHand } from '../src/utils/pokerStarsExport';
import type { HandRecord } from '../src/components/table/HandHistoryPanel';

const row = JSON.parse(readFileSync('tests/fixtures-realhands.json', 'utf8')).find(
  (r: { rake_amount?: number }) => Number(r.rake_amount) > 0
);
const model = { ...buildReplay(replayInputFromRow(row)), rake: 3, bbjFee: 0.3 };
const record: HandRecord = {
  id: 'privacy-hand',
  handNumber: 77,
  timestamp: 0,
  gameType: 'NLH',
  blinds: '1/2',
  players: [],
  streets: [],
  winners: [],
  heroId: 'viewer',
  heroResult: 0,
  potTotal: model.potTotal,
  wentToShowdown: true,
  muckedIds: [],
  rake: 3,
  bbjFee: 0.3,
  replay: model,
};
afterEach(cleanup);
const noDeductions = (text: string | null) =>
  expect(text).not.toMatch(/rake|jackpot fee|jackpot drop|taken from the pot/i);

describe('hand displays never disclose house deductions', () => {
  it('removes deductions from the shared rundown, including legacy models', () => {
    const { container } = render(<HandDetailView model={model} />);
    noDeductions(container.textContent);
    expect(container.textContent).toContain('Pot');
  });
  it('removes deductions from both real detail-modal tabs', () => {
    const { container, getByRole } = render(
      <HandDetailModal isOpen onClose={() => {}} hands={[record]} heroId="viewer" />
    );
    noDeductions(container.textContent);
    expect(container.querySelector('.hdm-potline__pots')).toBeTruthy();
    fireEvent.click(getByRole('tab', { name: 'Hand Detail' }));
    noDeductions(container.textContent);
  });
  it('omits deductions from both the share model and the wire even for older callers', () => {
    const hand = shareableFromModel(model, { id: 'privacy-hand', tableName: 'Arena' });
    expect(hand.rake).toBeUndefined();
    expect(hand.bbjFee).toBeUndefined();
    const decoded = decodeHandFromUrl(encodeHand({ ...hand, rake: 3, bbjFee: 0.3 }));
    expect(decoded).toBeTruthy();
    expect(decoded?.rake).toBeUndefined();
    expect(decoded?.bbjFee).toBeUndefined();
    expect(decoded?.potTotal).toBe(hand.potTotal);
    expect(decoded?.winners).toEqual(hand.winners);
  });
  it('omits deductions from downloaded hand text', () => {
    noDeductions(toPokerStarsHand(model, { tableName: 'Arena', handNumber: 77 }).text);
  });
  it('keeps archive rows and copied hand text free of deduction renderers', () => {
    for (const file of [
      'src/components/table/HandHistoryPanel.tsx',
      'src/pages/HandHistoryPage.tsx',
    ]) {
      const source = readFileSync(file, 'utf8');
      expect(source).not.toMatch(/className="(?:hh-entry__rake|pot-rake)"/);
      expect(source).not.toMatch(/rake:\s*h\.rake/);
      expect(source).not.toMatch(/lines\.push\(`(?:Rake|Jackpot fee):/);
    }
  });
});
