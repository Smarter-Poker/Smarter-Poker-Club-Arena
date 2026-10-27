import { expect, it, vi } from 'vitest';
vi.mock('../../src/core/MasterBus', () => ({ masterBus: { emit: vi.fn() } }));
import { masterBus } from '../../src/core/MasterBus';
import {
  closeLightningSessionSummary,
  openLightningSessionSummary,
} from '../../src/lightning/lightningSummaryStore';
it('closes the Lightning table only on summary acknowledgement without requesting leave', () => {
  openLightningSessionSummary({
    poolSessionId: 'session',
    clusterId: 'cluster',
    name: null,
    closeTableId: 'table',
    closeSeat: 3,
  });
  expect(masterBus.emit).not.toHaveBeenCalled();
  closeLightningSessionSummary();
  expect(masterBus.emit).toHaveBeenNthCalledWith(1, 'TABLE_LEFT', { tableId: 'table', seat: 3 });
  expect(masterBus.emit).toHaveBeenNthCalledWith(2, 'TABLE_MENU_ACTION', {
    tableId: 'table',
    action: 'CLOSE_TABLE_TAB',
  });
  closeLightningSessionSummary();
  expect(masterBus.emit).toHaveBeenCalledTimes(2);
});
