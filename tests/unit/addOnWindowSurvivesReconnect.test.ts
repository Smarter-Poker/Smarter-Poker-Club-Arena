import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const tablePage = readFileSync(join(process.cwd(), 'src/pages/TablePage.tsx'), 'utf8');
const tournamentService = readFileSync(
  join(process.cwd(), 'src/services/TournamentService.ts'),
  'utf8'
);

describe('an open add-on window survives client reconnects', () => {
  it('loads the durable add-on contract with the tournament bootstrap row', () => {
    expect(tablePage).toMatch(
      /\.from\('tournaments'\)[\s\S]*?\.select\([\s\S]*?addon_period_triggered[\s\S]*?addon_period_started_at[\s\S]*?addon_period_ends_at[\s\S]*?prize_pool_finalized/
    );
  });

  it('uses one quote and absolute-deadline presenter for bootstrap and Realtime', () => {
    expect(tablePage).toContain('const presentAddOnOffer = async');
    expect(tablePage).toMatch(
      /const presentPersistedAddOnOffer = async[\s\S]*?addon_period_triggered === true[\s\S]*?endsAt > Date\.now\(\)[\s\S]*?presentAddOnOffer\(\{[\s\S]*?endsAt: tournamentRow\?\.addon_period_ends_at/
    );
    expect(tablePage).toMatch(
      /void presentPersistedAddOnOffer\([\s\S]*?tournData as Record<string, unknown>/
    );
    expect(tablePage).toMatch(
      /data\?\.type === 'ADDON_PERIOD_START'[\s\S]*?presentAddOnOffer\(\(data\.payload \|\| \{\}\)/
    );
    expect(tablePage).not.toMatch(
      /resolvedEndMs\s*=\s*Number\.isFinite\(broadcastEndMs\)[\s\S]*?Date\.now\(\)\s*\+/
    );
  });

  it('never turns an explicit zero add-on fee into a surcharge fallback', () => {
    expect(tablePage).toMatch(
      /const rawFee = Number\(addonData\.addOnFee\)[\s\S]*?Number\.isFinite\(rawFee\)[\s\S]*?if \(!cost \|\| !chips \|\| !Number\.isFinite\(fee\)\)/
    );
  });

  it('presents only to a playing player without an add-on who still owns a live seat', () => {
    expect(tablePage).toMatch(
      /Promise\.all\(\[[\s\S]*?readPlayerBalance[\s\S]*?\.from\('tournament_players'\)[\s\S]*?\.select\('status, add_on'\)[\s\S]*?\.from\('table_seats'\)[\s\S]*?\.is\('left_at', null\)/
    );
    expect(tablePage).toMatch(
      /playerProof\.data\.status !== 'playing'[\s\S]*?playerProof\.data\.add_on === true[\s\S]*?!seatProof\.data/
    );
    expect(tablePage).toMatch(/if \(playerProof\.error \|\| seatProof\.error\)[\s\S]*?return;/);
  });

  it('does not let stale bootstrap work regress or reopen a newer offer', () => {
    expect(tablePage).toContain('const addOnPresentationEpochRef = useRef(0)');
    expect(tablePage).toMatch(
      /const presentationEpoch = \+\+addOnPresentationEpochRef\.current[\s\S]*?presentationEpoch !== addOnPresentationEpochRef\.current/
    );
    expect(tablePage).toMatch(
      /data\?\.type === 'ADDON_PERIOD_END'[\s\S]*?addOnPresentationEpochRef\.current \+= 1;[\s\S]*?active: false/
    );
    expect(tablePage).toMatch(
      /processAddOn\([\s\S]*?addOnPresentationEpochRef\.current \+= 1;[\s\S]*?active: false/
    );
    expect(tablePage).toMatch(
      /onAddOnDecline=\{\(\) => \{[\s\S]*?addOnPresentationEpochRef\.current \+= 1;[\s\S]*?active: false/
    );
  });

  it('re-reads the durable window after maintenance thaw and engine reconnect', () => {
    expect(tablePage).toContain(
      'const refreshPersistedAddOnOfferRef = useRef<(() => Promise<void>) | null>(null)'
    );
    expect(tablePage).toMatch(
      /const refreshPersistedAddOnOffer = async[\s\S]*?\.from\('tournaments'\)[\s\S]*?addon_period_ends_at[\s\S]*?presentPersistedAddOnOffer/
    );
    expect(tablePage).toMatch(
      /engineWsStatus !== 'connected'[\s\S]*?refreshPersistedAddOnOfferRef\.current\?\.\(\)/
    );
    expect(tablePage).toMatch(
      /evt\.type === 'MAINTENANCE_BREAK_ENDED'[\s\S]*?refreshPersistedAddOnOfferRef\.current\?\.\(\)/
    );
  });

  it('lets a pre-seated Free Buy player use the offer before the first hand', () => {
    expect(tablePage).toMatch(
      /\['REGISTERING', 'RUNNING'\]\.includes\(String\(tournamentRow\.status\)\)/
    );
    expect(tournamentService).toMatch(
      /async canAddOn\([\s\S]*?\['REGISTERING', 'RUNNING'\]\.includes\(String\(tournament\.status\)\)/
    );
  });
});
