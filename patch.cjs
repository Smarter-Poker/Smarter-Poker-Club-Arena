const fs = require('fs');
const content = fs.readFileSync('src/pages/TablePage.tsx', 'utf8');

const target = `                const { data: rpcData, error: rpcErr } = await supabase.rpc('atomic_table_buyin', {
                  p_user_id: userId,
                  p_table_id: tableId,
                  p_seat_number: selectedSeat,
                  p_amount: amount,
                  p_auto_rebuy: autoRebuy || false,
                  p_idempotency_key: crypto.randomUUID(),
                  // UNION LAW (Dan 2026-08-20): the club the player entered
                  // through. Chips come out of THAT club's wallet and the rake
                  // is earned for that club only — club wallets are never
                  // commingled. Ignored while union.club_scoped_chips is off.
                  p_club_id: useUserStore.getState().currentClubId ?? null,
                });
                if (rpcErr) {
                  reportError(rpcErr, 'TablePage.atomic_table_buyin_FAILED');
                  throw new Error('Failed to buy-in: ' + rpcErr.message);
                }`;

const replacement = `                const idempotencyKey = crypto.randomUUID();
                const payload = {
                  p_user_id: userId,
                  p_table_id: tableId,
                  p_seat_number: selectedSeat,
                  p_amount: amount,
                  p_auto_rebuy: autoRebuy || false,
                  p_idempotency_key: idempotencyKey,
                  p_club_id: useUserStore.getState().currentClubId ?? null,
                };
                const { data: rpcData, error: rpcErr } = await supabase.rpc('atomic_table_buyin', payload);
                if (rpcErr) {
                  reportError(rpcErr, 'TablePage.atomic_table_buyin_FAILED');
                  if (rpcErr.message?.includes('FetchError') || !navigator.onLine) {
                    OfflineQueueService.enqueue('TABLE_BUYIN', payload, idempotencyKey);
                    toast.success('Offline: Buy-in queued for retry.');
                    // Don't throw, let the optimistic UI hold the seat
                    return;
                  }
                  throw new Error('Failed to buy-in: ' + rpcErr.message);
                }`;

fs.writeFileSync('src/pages/TablePage.tsx', content.replace(target, replacement));
