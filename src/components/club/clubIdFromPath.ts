/** Resolve the club already visible in the URL before cache or network work. */
export function clubIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/clubs\/([^/]+)(?:\/|$)/);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}
