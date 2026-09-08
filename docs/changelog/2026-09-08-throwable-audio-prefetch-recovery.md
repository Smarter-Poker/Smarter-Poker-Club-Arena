# Recover throwable audio after offline preload

Failed preloads now evict their own cached result, so the first throw after reconnection can fetch and play sound. Cleanup compares promise identity to avoid removing a newer request. Seven audio lifecycle tests pass, including offline preload recovery, cancellation, codec fallback and bounded network deadlines.
