// GitHub displays reusable jobs with the exact caller job name. Do not strip
// arbitrary prefixes: only this protected publisher's one transaction is valid.
const KEYS = new Set(['publish-to-origin', 'retain-runtime']);
export function publisherJobKey(name) {
  if (KEYS.has(name)) return name;
  for (const key of KEYS) if (name === `production / ${key}`) return key;
  return null;
}
