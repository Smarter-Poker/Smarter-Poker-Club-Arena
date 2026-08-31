import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const store = readFileSync(path.resolve(__dirname, '../../src/stores/useClubStore.ts'), 'utf8');

describe('the global club store does not pull club queries into startup', () => {
  it('uses only the create payload type at module evaluation', () => {
    expect(store).toContain("import type { CreateClubData } from '@/services/ClubsService'");
    expect(store).not.toContain("import { ClubsService } from '@/services/ClubsService'");
  });

  it('loads the service when an action actually needs it', () => {
    expect(store).toContain("import('@/services/ClubsService')");
    expect(store).toContain('await getClubsService()');
  });
});
