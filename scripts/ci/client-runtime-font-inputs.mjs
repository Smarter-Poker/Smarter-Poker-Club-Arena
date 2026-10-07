import { createHash } from 'node:crypto';
export const FONT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
export const fontInputHash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function validateFontInputs(receipt) {
  if (
    receipt?.schema !== 1 ||
    receipt.userAgent !== FONT_UA ||
    !Array.isArray(receipt.files) ||
    receipt.files.length < 2 ||
    receipt.files.length > 101
  )
    throw new Error('No complete external font input receipt.');
  const seen = new Set();
  receipt.files.forEach((file, index) => {
    const url = new URL(file.url);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      url.hash ||
      (index === 0
        ? url.hostname !== 'fonts.googleapis.com' || url.pathname !== '/css2' || !url.search
        : url.hostname !== 'fonts.gstatic.com' ||
          !(url.pathname.startsWith('/s/') || url.pathname === '/l/font')) ||
      seen.has(file.url) ||
      !/^[0-9a-f]{64}$/.test(file.sha256) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes <= 0 ||
      file.bytes > 2097152
    )
      throw new Error('Invalid external font input.');
    seen.add(file.url);
  });
  if (receipt.files.reduce((sum, file) => sum + file.bytes, 0) > 4194304)
    throw new Error('External font input size exceeds the qualification budget.');
  return receipt;
}
export async function verifyFontInputs(receipt, fetcher = fetch) {
  validateFontInputs(receipt);
  const signal = AbortSignal.timeout(60000);
  let css;
  for (const [index, file] of receipt.files.entries()) {
    const response = await fetcher(file.url, {
      headers: { 'User-Agent': receipt.userAgent, 'Cache-Control': 'no-cache' },
      redirect: 'error',
      signal,
    });
    if (!response.ok) throw new Error('External font input unavailable.');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length !== file.bytes || fontInputHash(bytes) !== file.sha256)
      throw new Error('External font input changed.');
    if (index === 0) css = bytes.toString('utf8');
  }
  const urls = [
    ...new Set(
      [...css.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g)].map((entry) => entry[1])
    ),
  ];
  if (JSON.stringify(urls) !== JSON.stringify(receipt.files.slice(1).map((file) => file.url)))
    throw new Error('External font receipt omitted or reordered a CSS input.');
}
