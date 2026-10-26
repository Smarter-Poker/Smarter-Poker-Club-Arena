/** Public trust configuration only. Root must provision the purpose-only key
 * in the canonical qualification secret store and commit its independent SPKI
 * digest here before any approval can be issued. No secret belongs in source. */
export const PHASE14_ISSUER_TRUSTED_PUBLIC_KEY_SHA256: string | null =
  '786634cbb4d0ace75f8c07ba9c0c661086e35b9ef62e77b6ddaba6cb049de4ce';
export const PHASE14_ISSUER_SECRET_NAME = 'HORSE_PHASE14_QUALIFICATION_SIGNING_KEY';
