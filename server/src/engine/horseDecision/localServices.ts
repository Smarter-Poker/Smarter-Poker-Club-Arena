import type { HorseDecisionWorkerDependencies } from './workerRuntime.js';

/** Explicit local authority hooks; no database clients, timers or writers at import. */
export interface HorseDecisionLocalServices {
  startMindPersistence(): void;
  stopMindPersistence(): Promise<void>;
  startTelemetry(): void;
  stopTelemetry(): Promise<void>;
  startGovernor(): void;
  stopGovernor(): void;
  startPolicyLoader(): void;
  stopPolicyLoader(): void;
  hydrateMindFromDb(): Promise<string | null>;
  hydrateMind(lastFlush: string | null): Promise<void>;
  loadCharts(): Promise<unknown>;
  loadPostflop(): Promise<unknown>;
  loadPostflopV31(): Promise<unknown>;
  startChartLoader(): void;
  stopChartLoader(): void;
  startPostflopLoader(): void;
  stopPostflopLoader(): void;
  startPostflopV31Loader(): void;
  stopPostflopV31Loader(): void;
}

/**
 * Compose the existing LOCAL lifecycle with its compute/mind dependencies.
 * Construction is inert. The runtime explicitly starts and joins this owner.
 * This is not a shadow configuration: callers must supply every authority hook.
 */
export function withLocalHorseDecisionServices(
  compute: Omit<HorseDecisionWorkerDependencies, 'startServices' | 'stopServices'>,
  services: HorseDecisionLocalServices
): HorseDecisionWorkerDependencies {
  let ownedServicesStarted = false;
  let stopOperation: Promise<void> | null = null;

  /** Stop every clock, then join both writers even when another hook throws. */
  function stopServices(): Promise<void> {
    if (stopOperation) return stopOperation;
    if (!ownedServicesStarted) return Promise.resolve();
    ownedServicesStarted = false;
    stopOperation = (async () => {
      const errors: unknown[] = [];
      for (const stop of [
        () => services.stopPostflopV31Loader(),
        () => services.stopPostflopLoader(),
        () => services.stopChartLoader(),
        () => services.stopPolicyLoader(),
        () => services.stopGovernor(),
      ]) {
        try {
          stop();
        } catch (error) {
          errors.push(error);
        }
      }
      const writers = await Promise.allSettled([
        Promise.resolve().then(() => services.stopTelemetry()),
        Promise.resolve().then(() => services.stopMindPersistence()),
      ]);
      for (const result of writers) if (result.status === 'rejected') errors.push(result.reason);
      if (errors.length)
        throw new AggregateError(errors, 'Failed to stop local horse decision services');
    })();
    return stopOperation;
  }

  async function startServices() {
    // The actual runtime joins startup before calling stopServices. A later
    // lifecycle may restart only after the prior writer drain fully succeeded.
    if (stopOperation) {
      await stopOperation;
      stopOperation = null;
    }
    if (ownedServicesStarted) return compute.workerReadiness();
    ownedServicesStarted = true;
    try {
      // Preserve the live ordering: dirty observations remain flushable even
      // while hydration reads are slow. READY still waits for all initial data.
      services.startMindPersistence();
      services.startTelemetry();
      services.startGovernor();
      services.startPolicyLoader();
      const lastFlush = await services.hydrateMindFromDb();
      await Promise.all([
        services.hydrateMind(lastFlush),
        services.loadCharts(),
        services.loadPostflop(),
        services.loadPostflopV31(),
      ]);
      services.startChartLoader();
      services.startPostflopLoader();
      services.startPostflopV31Loader();
      return compute.workerReadiness();
    } catch (error) {
      try {
        await stopServices();
      } catch (stopError) {
        throw new AggregateError(
          [error, stopError],
          'Local horse services failed to start and stop'
        );
      }
      throw error;
    }
  }

  return { ...compute, startServices, stopServices };
}
