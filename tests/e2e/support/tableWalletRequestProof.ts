import type { Page, Request } from '@playwright/test';

const WALLET_RPC_PATH = '/rest/v1/rpc/fn_player_spendable_balance';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Count only the real WalletService read. Never retain payloads or actor IDs. */
export function observeTableWalletRequests(page: Page) {
  const counts = { guest: 0, empty: 0, malformed: 0, identified: 0 };
  let tableMounted = false;
  let targetTable: string | null = null;
  let identifiedTableReads = 0;
  let stopped = false;
  const observe = (request: Request) => {
    if (new URL(request.url()).pathname !== WALLET_RPC_PATH) return;
    try {
      const body: unknown = request.postDataJSON();
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        counts.malformed++;
        return;
      }
      const actor = (body as Record<string, unknown>).p_user_id;
      if (actor == null || (typeof actor === 'string' && !actor.trim())) counts.empty++;
      else if (actor === 'guest') counts.guest++;
      else if (typeof actor !== 'string' || !UUID.test(actor)) counts.malformed++;
      else {
        counts.identified++;
        if (targetTable && (body as Record<string, unknown>).p_table_id === targetTable)
          identifiedTableReads++;
      }
    } catch {
      counts.malformed++;
    }
  };
  page.on('request', observe);
  return {
    targetTable(tableId: string) {
      targetTable = tableId;
    },
    markTableMounted() {
      tableMounted = true;
    },
    stop() {
      if (!stopped) page.off('request', observe);
      stopped = true;
      return {
        rpc: 'fn_player_spendable_balance',
        tableMounted,
        observationComplete: stopped,
        counts: { ...counts },
        identifiedTableReads,
        verdict:
          counts.guest + counts.empty > 0
            ? 'failed'
            : !tableMounted || counts.malformed > 0 || identifiedTableReads === 0
              ? 'unknown'
              : 'passed',
      } as const;
    },
  };
}
