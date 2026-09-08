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
  title?: string
): Promise<boolean> {
  const [{ Filesystem, Directory }, { Share }] = await Promise.all([
    import('@capacitor/filesystem'),
    import('@capacitor/share'),
  ]);
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.readAsDataURL(blob);
  });
  const safe = filename.replace(/[^A-Za-z0-9._-]+/g, '-');
  const written = await Filesystem.writeFile({
    path: `share/${safe}`,
    data: base64,
    directory: Directory.Cache,
    recursive: true,
  });
  await Share.share({ title: title || safe, files: [written.uri] });
  return true;
}
