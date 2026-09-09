import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8');

const service = source('src/services/TournamentService.ts');
const tournamentPage = source('src/pages/TournamentPage.tsx');
const tablePage = source('src/pages/TablePage.tsx');

describe('every player rebuy prompt owns one required idempotency token', () => {
  it('makes the service token mandatory and refuses an empty runtime value', () => {
    const start = service.indexOf('async processRebuy(');
    const end = service.indexOf('\n  /**', start + 1);
    const processRebuy = service.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(processRebuy).toMatch(/clientToken:\s*string/);
    expect(processRebuy).not.toMatch(/clientToken\?:\s*string/);
    expect(processRebuy).toContain("typeof clientToken !== 'string'");
    expect(processRebuy).toContain('clientToken.trim()');
    expect(processRebuy).toContain('normalizedClientToken.length > 128');
    expect(processRebuy).not.toContain('await this.canRebuy(');
    expect(processRebuy).toMatch(/p_client_token:\s*normalizedClientToken/);
    expect(processRebuy).not.toMatch(/p_client_token:\s*clientToken\s*\?\?/);
  });

  it('keeps one Tournament Page token through retries and retires it on success', () => {
    expect(tournamentPage).toContain('const rebuyPromptTokenRef = useRef<string | null>(null)');
    expect(tournamentPage).toMatch(
      /const beginRebuyPrompt = useCallback[\s\S]*?if \(rebuyPromptTokenRef\.current\)[\s\S]*?return rebuyPromptTokenRef\.current/
    );
    expect(tournamentPage).toMatch(
      /const clientToken = beginRebuyPrompt\(\);[\s\S]*?processRebuy\([\s\S]*?clientToken[\s\S]*?\)/
    );
    expect(tournamentPage).toMatch(
      /if \(result\.success\) \{[\s\S]*?endRebuyPrompt\(\);[\s\S]*?setCanRebuyNow\(false\)/
    );
    expect(tournamentPage).toMatch(
      /useEffect\(\(\) => \{\s*endRebuyPrompt\(\);\s*if \(canRebuyNow\) beginRebuyPrompt\(\);[\s\S]*?canRebuyNow,[\s\S]*?selectedTournament\?\.id,[\s\S]*?currentUser\.id/
    );
    expect(tournamentPage).toContain('const token = uuid()');
  });

  it('keeps one Table Page token from offer through every retry', () => {
    expect(tablePage).toContain('const rebuyPromptTokenRef = useRef<string | null>(null)');
    expect(tablePage).toMatch(
      /const beginRebuyPrompt = useCallback[\s\S]*?if \(rebuyPromptTokenRef\.current\)[\s\S]*?return rebuyPromptTokenRef\.current[\s\S]*?const token = uuid\(\)/
    );
    expect(tablePage).toMatch(
      /const token = rebuyPromptTokenRef\.current \?\? beginRebuyPrompt\(\);[\s\S]*?processRebuy\(tableState\.tournamentId, userId, token\)/
    );
    expect(tablePage).toMatch(
      /processRebuy\(tableState\.tournamentId, userId, token\);[\s\S]*?endRebuyPrompt\(\)/
    );
    expect(tablePage).toMatch(
      /Unanswered for two minutes is a decline[\s\S]*?setShowRebuyModal\(false\);[\s\S]*?endRebuyPrompt\(\)/
    );
  });

  it('does not retain the unreachable duplicate tournament purchase modals', () => {
    for (const path of [
      'src/components/tournament/RebuyModal.tsx',
      'src/components/tournament/AddOnModal.tsx',
      'src/components/tournament/RebuyModal.css',
    ]) {
      expect(existsSync(resolve(process.cwd(), path)), path).toBe(false);
    }
  });

  it('advertises only the zero-stack, unpaid, in-window entry the SQL authority accepts', () => {
    const start = service.indexOf('async canRebuy(');
    const end = service.indexOf('\n  /**', start + 1);
    const canRebuy = service.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(canRebuy).toContain('chips, status, prize, rebuys, rebuy_prompt_until');
    expect(canRebuy).toContain('Number(player.chips ?? 0) !== 0');
    expect(canRebuy).toContain('Number(player.prize ?? 0) > 0');
    expect(canRebuy).toContain("playerStatus !== 'playing'");
    expect(canRebuy).toContain('promptUntil <= Date.now()');
    expect(canRebuy).toContain('tournament.max_reentries');
    expect(canRebuy).toContain('tournament.max_rebuys');
    expect(canRebuy).not.toContain('player.chips > tournament.starting_chips');
  });
});

describe('an add-on retry reaches its immutable server receipt', () => {
  it('does not preflight mutable window or duplicate state before the money RPC', () => {
    const start = service.indexOf('async processAddOn(');
    const end = service.indexOf('\n  /*', start + 1);
    const processAddOn = service.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(processAddOn).not.toContain('await this.canAddOn(');
    expect(processAddOn).not.toContain(".from('wallet_transactions')");
    expect(processAddOn).toContain("supabase.rpc('process_tournament_rebuy'");
    expect(processAddOn).toContain("p_rebuy_type: 'addon'");
  });

  it('opens the confirmed persisted offer instead of buying from the table menu', () => {
    const start = tablePage.indexOf('const handleTournamentAddOn = async () =>');
    const end = tablePage.indexOf('\n  // Handle leave table', start);
    const menuAction = tablePage.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(menuAction).toContain('refreshPersistedAddOnOfferRef.current');
    expect(menuAction).toContain('await refreshOffer()');
    expect(menuAction).not.toContain('processAddOn(');
    expect(menuAction).not.toContain('setShowRebuyModal(false)');
  });
});
