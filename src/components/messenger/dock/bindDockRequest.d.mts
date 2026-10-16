export function requestForDockActor(
  url: string,
  options: RequestInit & { actorId?: string; currentActor?: () => string | null },
  getToken: () => Promise<string | null>,
  fetcher?: typeof fetch
): Promise<Response>;
