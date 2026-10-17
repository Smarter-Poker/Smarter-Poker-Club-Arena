import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chipKindWord } from '../../src/utils/chipKindWord';
import { exactChipFigure } from '../../src/utils/cashierAmount';

const read = (rel: string) => readFileSync(resolve(__dirname, '../..', rel), 'utf8');

describe('the 2026-10-17 sweep: client fixes', () => {
  it('prints wallet ledger chips with both cent digits or none (P-24)', () => {
    const src = read('src/components/wallet/TransactionHistory.tsx');
    expect(src).toContain('{exactChipFigure(Math.abs(tx.amount))}');
    expect(src).toContain('Bal: {exactChipFigure(tx.balance)}');
    expect(src).not.toContain('tx.amount.toLocaleString()');
    expect(src).not.toContain('tx.balance.toLocaleString()');
    expect(exactChipFigure(411.8)).toBe('411.80');
    expect(exactChipFigure(1731.2)).toBe('1,731.20');
    expect(exactChipFigure(1057)).toBe('1,057');
    const receipts = read('src/components/wallet/CashoutReceiptChecks.tsx');
    expect(receipts).toContain('{exactChipFigure(card.amount)} Chips');
  });

  it('names Trade Record kinds with the statement words', () => {
    expect(chipKindWord('cashout')).toBe('Cash-Out');
    expect(chipKindWord('tournament_buyin')).toBe('Tournament Buy-In');
    expect(chipKindWord('buyin')).toBe('Buy-In');
    expect(chipKindWord('club_bank_send')).toBe('Club Bank Send');
    expect(read('src/pages/CashierTradePage.tsx')).toContain(
      "return value ? chipKindWord(value) : '';"
    );
    expect(read('src/pages/CashierStatementsPage.tsx')).toContain('const kindWord = chipKindWord;');
  });

  it('reads every accepted friend into the Send picker, past any row cap', () => {
    const src = read('src/pages/PlayerWalletPage.tsx');
    const picker = src.slice(src.indexOf('const loadFriends = useCallback'));
    const body = picker.slice(0, picker.indexOf('}, [user?.id, isMounted]);'));
    const code = body.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toContain('.limit(');
    expect(body).toContain(".order('id', { ascending: true })");
    expect(body).toContain('.range(from, from + FRIEND_PAGE - 1)');
    expect(body).toContain('ids.slice(i, i + NAME_CHUNK)');
  });

  it('names every routed page that used to keep the last title', () => {
    for (const [file, name] of [
      ['src/pages/TransactionHistoryPage.tsx', "usePageTitle('Transactions')"],
      ['src/pages/VIPPage.tsx', "usePageTitle('VIP')"],
      ['src/pages/RakebackPage.tsx', "usePageTitle('Rakeback')"],
      ['src/pages/PromotionsPage.tsx', "usePageTitle('Promotions')"],
      ['src/pages/DailyBonusPage.tsx', "usePageTitle('Bonuses')"],
      ['src/pages/PlayerStatsPage.tsx', "usePageTitle('Player Stats')"],
      ['src/pages/NotFoundPage.tsx', "usePageTitle('Page Not Found')"],
      ['src/pages/ClubPlayersDoor.tsx', "usePageTitle('Players')"],
      ['src/pages/club/ClubDataSimplePage.tsx', "usePageTitle('Club Data')"],
      ['src/pages/ClubHomePage.tsx', 'usePageTitle(club?.name ?? null)'],
    ] as const) {
      expect(read(file), file).toContain(name);
    }
  });

  it('prints no path through Title Case on the 404 page', () => {
    expect(read('src/pages/NotFoundPage.tsx')).not.toContain('location.pathname');
  });

  it('opens a published prize board on the metric the prizes are paid on', () => {
    const src = read('src/pages/LeaderboardPage.tsx');
    expect(src).toContain(
      'if (!metricChosenRef.current && data?.rewards_enabled && data.payout_metric) {'
    );
    expect(src).toContain('metricChosenRef.current = true;');
  });
});
