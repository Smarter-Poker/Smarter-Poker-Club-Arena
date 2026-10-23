import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['src/engine/HorseOpponentMemory.postgres.ts'],
    maxWorkers: 1,
    minWorkers: 1,
  },
});
