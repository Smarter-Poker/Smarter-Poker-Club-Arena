import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist', 'node_modules'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      // Phase U2 Stage D (2026-04-23): ban imports from the deleted client-side
      // engine directory. The Hetzner game server owns all game logic; pure type
      // shapes live in `src/types/engine/*` and are explicitly permitted. If
      // you're tempted to import from `src/engine/`, you're reintroducing the
      // dual-engine hazard.
      //
      // Uses a regex lookahead to match `engine/` paths EXCEPT those that sit
      // under a `types/` ancestor. Handles all of:
      //   '../engine/X'          → blocked
      //   '../../engine/X'       → blocked
      //   '@/engine/X'           → blocked
      //   'src/engine/X'         → blocked
      //   '../types/engine/X'    → allowed
      //   '../../types/engine/X' → allowed
      //   '@/types/engine/X'     → allowed
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^(?!.*types/)(?:(?:\\.{1,2}\\/)+|@\\/|src\\/)engine\\/',
              message:
                'src/engine/* was deleted in Phase U2 (server-authoritative migration). ' +
                'For game logic, call the Hetzner HTTP API via GameServerAPI. ' +
                'For type shapes, import from src/types/engine/*. ' +
                'See: docs/U2-CALLER-INVENTORY.md',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['server/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
)
