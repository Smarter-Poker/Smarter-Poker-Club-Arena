const MEMBERSHIPS_WARM_TTL_MS = 5_000;

let membershipsInflight: {
  key: string;
  settledAt: number | null;
  promise: Promise<unknown>;
} | null = null;

/** Drop the in-memory warm-start window synchronously during sign-out. */
export function clearMembershipsWarmCache(): void {
  membershipsInflight = null;
}

export function getWarmMemberships<T>(key: string): Promise<T> | null {
  const warm = membershipsInflight;
  if (!warm || warm.key !== key) return null;
  if (warm.settledAt !== null && Date.now() - warm.settledAt >= MEMBERSHIPS_WARM_TTL_MS) {
    return null;
  }
  return warm.promise as Promise<T>;
}

export function rememberWarmMemberships<T>(key: string, promise: Promise<T>): Promise<T> {
  const entry = { key, settledAt: null as number | null, promise };
  membershipsInflight = entry;
  void promise.then(
    () => {
      if (membershipsInflight === entry) entry.settledAt = Date.now();
    },
    () => {
      if (membershipsInflight === entry) membershipsInflight = null;
    }
  );
  return promise;
}
