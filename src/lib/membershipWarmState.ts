const MEMBERSHIPS_WARM_TTL_MS = 5_000;

let membershipsInflight: {
  key: string;
  at: number;
  promise: Promise<unknown>;
} | null = null;

/** Drop the in-memory warm-start window synchronously during sign-out. */
export function clearMembershipsWarmCache(): void {
  membershipsInflight = null;
}

export function getWarmMemberships<T>(key: string): Promise<T> | null {
  const warm = membershipsInflight;
  if (!warm || warm.key !== key || Date.now() - warm.at >= MEMBERSHIPS_WARM_TTL_MS) return null;
  return warm.promise as Promise<T>;
}

export function rememberWarmMemberships<T>(key: string, promise: Promise<T>): Promise<T> {
  membershipsInflight = { key, at: Date.now(), promise };
  promise.catch(() => {
    if (membershipsInflight?.promise === promise) membershipsInflight = null;
  });
  return promise;
}
