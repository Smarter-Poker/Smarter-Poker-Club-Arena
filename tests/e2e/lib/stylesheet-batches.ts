import type { APIRequestContext } from '@playwright/test';

/** Keep the complete cascade in discovery order without a request per lazy route. */
export async function readStylesheetBatches(
  request: Pick<APIRequestContext, 'get'>,
  arena: string,
  names: readonly string[]
): Promise<string[]> {
  const styles: string[] = [];
  // Match the existing live-CSS fixture's bound, including response bodies.
  for (let start = 0; start < names.length; start += 4) {
    const batch = await Promise.all(
      names.slice(start, start + 4).map(async (name) => {
        const response = await request.get(`${arena}/${name}`);
        if (!response.ok()) {
          throw new Error(`stylesheet ${name} must load: HTTP ${response.status()}`);
        }
        return response.text();
      })
    );
    styles.push(...batch);
  }
  return styles;
}
