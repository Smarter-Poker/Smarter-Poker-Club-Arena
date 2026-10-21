/** Stateful server-recovery model for mounted cashier tests. Native SQL tests
 * separately qualify authorization, transaction locks and envelope validation. */
export function cashierRecoveryRpc() {
  const rows = new Map<string, Record<string, any>>();
  return {
    clear: () => rows.clear(),
    answer(name: string, args: Record<string, any>) {
      if (!name.startsWith('fn_cashier_browser_recovery_')) return undefined;
      const prefix = `${args.p_actor_id}:${args.p_club_id}:${args.p_kind}:`;
      const key = prefix + args.p_intent_key;
      const copy = (value: unknown) => structuredClone(value);
      if (name.endsWith('_reserve')) {
        if (!rows.has(key)) rows.set(key, copy(args.p_envelope) as Record<string, any>);
        return { data: copy(rows.get(key)), error: null };
      }
      if (name.endsWith('_read'))
        return {
          data: [...rows].filter(([k]) => k.startsWith(prefix)).map(([, v]) => copy(v)),
          error: null,
        };
      const row = rows.get(key);
      const same = (row?.operationId ?? row?.submissionId) === args.p_identity;
      if (name.endsWith('_update')) {
        const immutable = (value: Record<string, any>) => {
          const { failures: _failures, ...fields } = value;
          return JSON.stringify(Object.entries(fields).sort(([a], [b]) => a.localeCompare(b)));
        };
        const next = args.p_envelope;
        const narrowed =
          same &&
          immutable(row!) === immutable(next) &&
          next.failures.every((failure: { userId: string }) =>
            row!.failures.some((original: { userId: string }) => original.userId === failure.userId)
          );
        if (narrowed) rows.set(key, copy(next) as Record<string, any>);
        return { data: narrowed, error: null };
      }
      if (name.endsWith('_ack')) {
        if (same) rows.delete(key);
        return { data: same, error: null };
      }
      throw new Error('Unexpected recovery RPC: ' + name);
    },
  };
}
