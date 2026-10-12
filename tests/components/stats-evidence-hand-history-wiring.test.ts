import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const page = readFileSync(resolve(root, 'src/pages/HandHistoryPage.tsx'), 'utf8');
const service = readFileSync(resolve(root, 'src/services/HandHistoryService.ts'), 'utf8');

describe('Stats evidence hand-history destination wiring', () => {
  it('pages Stats evidence on the server and renders only its authorized exact ids', () => {
    expect(page).toContain('StatsEvidenceService.list(');
    expect(page).toContain('StatsEvidenceService.listCashSession(');
    expect(page).toContain('evidenceCursorRef.current');
    expect(page).toContain(
      'handHistoryService.getHandsByIds(page.hands.map((hand) => hand.hand_id))'
    );
    expect(page).toMatch(/useStatsEvidence\s*\?\s*rows/);
    expect(service).toContain(".from('hand_history')");
    expect(service).toContain(".in('id', ids)");
    expect(service).toContain('return ids.flatMap');
  });

  it('keeps ordinary archive pagination separate from Stats evidence pagination', () => {
    expect(page).toContain('offset: rows.length');
    expect(page).toContain('useStatsEvidence');
    expect(page).toContain('page ? page.has_more : data.length === PAGE_SIZE');
  });
});
