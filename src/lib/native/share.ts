/**
 * Hand a file to the player (native only). A webview does not honour
 * <a download>, so every CSV export and the share-card fallback used to end
 * in nothing. Write the bytes to the app's cache directory and open the
 * system share sheet on the file - the same sheet navigator.share opens when
 * it is available, which on Android's webview it is not.
 */
export async function nativeShareBlob(
  blob: Blob,
  filename: string,
  title?: string,
  isCurrent?: () => boolean
): Promise<boolean> {
  const check = () => {
    if (isCurrent && isCurrent() !== true) throw new Error('export_account_or_view_changed');
  };
  check();
  const [{ Filesystem, Directory }, { Share }] = await Promise.all([
    import('@capacitor/filesystem'),
    import('@capacitor/share'),
  ]);
  check();
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.readAsDataURL(blob);
  });
  check();
  const safe = filename.replace(/[^A-Za-z0-9._-]+/g, '-');
  const written = await Filesystem.writeFile({
    path: `share/${safe}`,
    data: base64,
    directory: Directory.Cache,
    recursive: true,
  });
  check();
  await Share.share({ title: title || safe, files: [written.uri] });
  return true;
}

/**
 * Share a link and its message through the system share sheet (native only).
 * Android's webview has no navigator.share, so without this the Share button
 * on the Share & Invite sheet only ever copied the link. Resolves false when
 * the player closes the sheet without sharing.
 */
export async function nativeShareText(title: string, text: string, url: string): Promise<boolean> {
  const { Share } = await import('@capacitor/share');
  try {
    await Share.share({ title, text, url, dialogTitle: title });
    return true;
  } catch (err) {
    // The plugin rejects with "Share canceled" when the sheet is dismissed.
    if (/cancel/i.test(String((err as Error)?.message || err))) return false;
    throw err;
  }
}
