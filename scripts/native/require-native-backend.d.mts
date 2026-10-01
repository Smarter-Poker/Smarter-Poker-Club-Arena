type BuildEnv = Record<string, string | undefined> | null | undefined;

export declare const NATIVE_BACKEND_KEYS: string[];
/** Everything wrong with the backend settings a native bundle would ship with. */
export declare function nativeBackendProblems(env: BuildEnv): string[];
/** Throws, naming every problem, when a native bundle could not reach its backend. */
export declare function assertNativeBackend(env: BuildEnv): void;
