/** Serving runtime capability, never inferred from a merged client or database row. */
export async function readCashRakePolicyVersion(): Promise<0 | 1 | null> {
  const base =
    import.meta.env.VITE_GAME_SERVER_URL ||
    (import.meta.env.PROD ? 'https://engine.smarter.poker' : 'http://localhost:8080');
  try {
    const response = await fetch(`${base}/health`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    const health = await response.json();
    if (!health || typeof health.version !== 'string') return null;
    if (health.cashRakePolicyVersion === 1) return 1;
    // A reachable older engine explicitly lacks this new contract.
    if (health.cashRakePolicyVersion === undefined) return 0;
    return null;
  } catch {
    return null;
  }
}
