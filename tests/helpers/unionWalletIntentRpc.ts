/** Stateful transport fixture. Native PG qualification proves these RPCs;
 * component tests use this adapter to retain identity across remounts. */
export function unionWalletIntentRpc() {
  const intents = new Map<string, string>();
  let counter = 0;
  return {
    clear: () => intents.clear(),
    call: (name: string, args: Record<string, unknown>, next: () => unknown) => {
      const key = JSON.stringify([
        args.p_actor_id,
        args.p_union_id,
        args.p_wallet_key,
        args.p_signature,
      ]);
      if (name === 'fn_union_wallet_reserve_intent') {
        if (!intents.has(key))
          intents.set(
            key,
            String(
              args.p_legacy_operation_id ||
                `cccccccc-cccc-4ccc-8ccc-${String(++counter).padStart(12, '0')}`
            )
          );
        return Promise.resolve({ data: intents.get(key), error: null });
      }
      if (name === 'fn_union_wallet_acknowledge_intent') {
        for (const [scope, operation] of intents) {
          if (operation === args.p_operation_id) intents.delete(scope);
        }
        return Promise.resolve({ data: null, error: null });
      }
      return next();
    },
  };
}
