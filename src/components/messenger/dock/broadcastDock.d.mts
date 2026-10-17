export function broadcastSync(name: string, message: unknown): void;
export function listenBroadcast(name: string, listener: (message: unknown) => void): () => void;
