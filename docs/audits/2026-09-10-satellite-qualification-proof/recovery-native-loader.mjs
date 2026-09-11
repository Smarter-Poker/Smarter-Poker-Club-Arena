const replacement = new URL('./recovery-native-transport.mjs', import.meta.url).href;
export async function resolve(specifier, context, nextResolve) {
  const url = new URL(specifier, context.parentURL ?? import.meta.url).href;
  if (
    [
      '/services/supabase.js',
      '/services/errorReporter.js',
      '/services/financialAlerts.js',
      '/maintenance/freezeState.js',
    ].some((s) => url.endsWith(s))
  )
    return { url: replacement, shortCircuit: true };
  return nextResolve(specifier, context);
}
