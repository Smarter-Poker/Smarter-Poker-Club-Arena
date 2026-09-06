import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path: string) => readFileSync(resolve(__dirname, `../../${path}`), 'utf8');

describe('spin phase 6 wiring', () => {
  it('keeps stacks board-defined and does not restore the retired tier', () => {
    const spec = read('src/config/spinSpec.ts');
    expect(spec).toContain('turbo: 300');
    expect(spec).toContain('deep: 1000');
    expect(spec).not.toMatch(/deep:\s*5_000/);
  });

  it('builds fallback reveals with a shared deal deadline and prize data', () => {
    const page = read('src/pages/TablePage.tsx');
    expect(page).toContain('revealDeadlineMs: (revealAtMs ?? Date.now()) + spinRevealToDealMs()');
    expect(page).toContain('started_at, spin_reveal_at, prize_pool');
  });

  it('shows a prize in the HUD and a paid finish without calling it a win', () => {
    expect(read('src/components/tournament/TournamentHUD.tsx')).toContain("? 'Prize' : 'Avg'");
    const overlay = read('src/components/table/TournamentWinnerOverlay.tsx');
    expect(overlay).toContain("paidFinish ? 'Paid Finish!' : 'Champion!'");
    expect(read('src/pages/TablePage.tsx')).toContain(
      "tournamentFormatRef.current === 'spin' && paidPrize > 0"
    );
  });

  it('skips full siblings before Play Again navigation', () => {
    const host = read('src/components/tournament/TournamentRankingHost.tsx');
    expect(host).toContain("select('id, current_players, max_players')");
    expect(host).toContain('candidate.current_players ?? 0) < Number(candidate.max_players ?? 0');
  });

  it('keeps the buy-in sheet keyboard-contained and usable on short screens', () => {
    const page = read('src/pages/TablePage.tsx');
    expect(page).toContain('useFocusTrap<HTMLDivElement>(seatFirstConfirm !== null)');
    expect(page).toContain('aria-labelledby="seat-buyin-confirm-title"');
    expect(read('src/pages/TablePage.css')).toContain('@media (max-height: 560px)');
  });

  it('shows an honest persistent fill indicator and a non-blocking heads-up cue', () => {
    const page = read('src/pages/TablePage.tsx');
    expect(page).toContain('Typical Fill In About');
    expect(page).toContain('Beyond Typical 3 Min, Waits Can Vary');
    expect(page).toContain('Heads Up · Playing For');
    expect(page).toContain('setSpinHeadsUpNote(false), 1500');
  });

  it('never automatically retries the registration debit', () => {
    const service = read('src/services/TournamentService.ts');
    const start = service.indexOf('async registerPlayer(');
    const end = service.indexOf('async unregisterPlayer(', start);
    const method = service.slice(start, end);
    expect(method).toMatch(/supabase\.rpc\('fn_register_for_tournament'/);
    expect(method).not.toContain('retryAsync(');
    expect(method).toContain(".from('tournament_players')");
    expect(method).toContain('registration_result_unconfirmed');
  });
});
