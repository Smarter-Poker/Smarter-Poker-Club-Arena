import { WEB_ORIGIN } from '../appBase';

/** Route a notification tap without loading device-token or permission plugins. */
export async function openPushUrl(rawUrl: string | undefined | null): Promise<void> {
  const url = typeof rawUrl === 'string' && rawUrl.trim() ? rawUrl.trim() : '/hub/club-arena';
  let absolute: string;
  try {
    absolute = new URL(url, WEB_ORIGIN).toString();
  } catch {
    absolute = `${WEB_ORIGIN}/hub/club-arena`;
  }
  const { parseAppUrl, handleAppUrl } = await import('./deepLinks');
  if (parseAppUrl(absolute)) {
    await handleAppUrl(absolute);
    return;
  }
  const { openInAppBrowser } = await import('./browser');
  await openInAppBrowser(absolute);
}
