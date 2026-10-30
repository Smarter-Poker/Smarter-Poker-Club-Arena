/** Pure client-test budget; never infer extra capacity from a runner label. */
export function clientVitestWorkerBudget({ requested, ci = false, availableCpus } = {}) {
  const hasRequest = requested !== undefined && requested !== '';
  if (!hasRequest && !ci) return undefined;

  // An unreadable CPU allowance must never expand parallel execution.
  const cpus = Number.isSafeInteger(availableCpus) && availableCpus > 0 ? availableCpus : 1;
  if (hasRequest) {
    const parsed =
      typeof requested === 'string' && /^[1-9]\d*$/.test(requested) ? Number(requested) : NaN;
    const wanted = Number.isSafeInteger(parsed) ? parsed : 2;
    return Math.min(cpus, wanted);
  }
  // Preserve the conservative no-override CI policy, including single-CPU VMs.
  return Math.min(cpus, Math.max(2, Math.floor(cpus / 4)));
}
