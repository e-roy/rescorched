// @ts-check
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Selectors + property bans that enforce the #1 core principle from TECH_STACK.md:
 * `packages/sim` is a pure, deterministic module. No wall-clock, no ambient
 * randomness, no platform APIs. Every random number comes from the seeded RNG
 * owned by the server.
 *
 * Do not relax these. If sim code "needs" the time or a random number, it needs
 * to take it as an argument instead.
 */
const PURITY_MESSAGE =
  'packages/sim must be pure and deterministic (TECH_STACK.md core principle 1 & 4). ' +
  'Take this value as an explicit argument, or draw randomness from the seeded RNG.';

/**
 * ECMAScript leaves the exact results of these `Math` functions up to the
 * engine. A trajectory computed with them can differ in the last bits between
 * workerd and a browser, which is exactly the class of bug that makes a shot
 * land in a different pixel on two clients. `packages/sim/src/math.ts` provides
 * deterministic replacements built from `+ - * /` and `Math.sqrt`.
 */
const ENGINE_DEFINED_MESSAGE =
  'This Math function is engine-defined and not bit-reproducible. ' +
  'Use the deterministic equivalent from packages/sim/src/math.ts.';

const bannedImpureProperties = [
  { object: 'Math', property: 'random', message: PURITY_MESSAGE },
  { object: 'Date', property: 'now', message: PURITY_MESSAGE },
  { object: 'performance', property: 'now', message: PURITY_MESSAGE },
  { object: 'crypto', property: 'randomUUID', message: PURITY_MESSAGE },
  { object: 'crypto', property: 'getRandomValues', message: PURITY_MESSAGE },
  { object: 'Math', property: 'sin', message: ENGINE_DEFINED_MESSAGE },
  { object: 'Math', property: 'cos', message: ENGINE_DEFINED_MESSAGE },
  { object: 'Math', property: 'tan', message: ENGINE_DEFINED_MESSAGE },
  { object: 'Math', property: 'asin', message: ENGINE_DEFINED_MESSAGE },
  { object: 'Math', property: 'acos', message: ENGINE_DEFINED_MESSAGE },
  { object: 'Math', property: 'atan', message: ENGINE_DEFINED_MESSAGE },
  { object: 'Math', property: 'atan2', message: ENGINE_DEFINED_MESSAGE },
  { object: 'Math', property: 'pow', message: ENGINE_DEFINED_MESSAGE },
  { object: 'Math', property: 'exp', message: ENGINE_DEFINED_MESSAGE },
  { object: 'Math', property: 'log', message: ENGINE_DEFINED_MESSAGE },
  { object: 'Math', property: 'log2', message: ENGINE_DEFINED_MESSAGE },
  { object: 'Math', property: 'log10', message: ENGINE_DEFINED_MESSAGE },
  { object: 'Math', property: 'cbrt', message: ENGINE_DEFINED_MESSAGE },
  { object: 'Math', property: 'hypot', message: ENGINE_DEFINED_MESSAGE },
  { object: 'Math', property: 'sinh', message: ENGINE_DEFINED_MESSAGE },
  { object: 'Math', property: 'cosh', message: ENGINE_DEFINED_MESSAGE },
  { object: 'Math', property: 'tanh', message: ENGINE_DEFINED_MESSAGE },
];

const bannedImpureSyntax = [
  {
    selector: "NewExpression[callee.name='Date']",
    message: PURITY_MESSAGE,
  },
  {
    selector: "CallExpression[callee.name='Date']",
    message: PURITY_MESSAGE,
  },
  {
    selector: "MemberExpression[object.name='globalThis'][property.name='Math']",
    message: PURITY_MESSAGE,
  },
  {
    selector: "BinaryExpression[operator='**']",
    message: ENGINE_DEFINED_MESSAGE,
  },
  {
    selector: "AssignmentExpression[operator='**=']",
    message: ENGINE_DEFINED_MESSAGE,
  },
];

const bannedPlatformGlobals = [
  'window',
  'document',
  'navigator',
  'localStorage',
  'sessionStorage',
  'fetch',
  'WebSocket',
  'caches',
  'location',
  'history',
  'requestAnimationFrame',
  'process',
  '__dirname',
  '__filename',
];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.wrangler/**',
      '**/coverage/**',
      '**/test-results/**',
      '**/playwright-report/**',
      '**/e2e/screenshots/**',
      '**/worker-configuration.d.ts',
      'pnpm-lock.yaml',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.es2023 },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
      'object-shorthand': 'error',
    },
  },

  // ---------------------------------------------------------------------
  // packages/sim — the purity fence.
  // ---------------------------------------------------------------------
  {
    files: ['packages/sim/src/**/*.ts'],
    languageOptions: {
      // Deliberately NO browser / node globals: sim gets the language, nothing else.
      globals: { ...globals.es2023 },
    },
    rules: {
      'no-restricted-properties': ['error', ...bannedImpureProperties],
      'no-restricted-syntax': ['error', ...bannedImpureSyntax],
      'no-restricted-globals': [
        'error',
        ...bannedPlatformGlobals.map((name) => ({ name, message: PURITY_MESSAGE })),
      ],
      'no-console': 'error',
    },
  },

  // Sim tests may use the clock (for benchmarking) but still never Math.random,
  // because a flaky-by-randomness test defeats the whole point.
  {
    files: ['packages/sim/**/*.test.ts', 'packages/sim/**/*.bench.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: PURITY_MESSAGE },
      ],
      'no-restricted-syntax': 'off',
      'no-restricted-globals': 'off',
      'no-console': 'off',
    },
  },

  // ---------------------------------------------------------------------
  // apps/client — browser globals; game rules are banned here by review,
  // and by the fact that the sim is the only place they can live.
  // ---------------------------------------------------------------------
  {
    files: ['apps/client/**/*.ts'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.es2023 },
    },
  },

  // apps/server — Workers runtime globals.
  {
    files: ['apps/server/**/*.ts'],
    languageOptions: {
      globals: { ...globals.worker, ...globals.es2023 },
    },
  },

  // Tooling / config / e2e — Node globals.
  {
    files: [
      '**/*.config.ts',
      '**/*.config.js',
      'e2e/**/*.ts',
      'scripts/**/*.{ts,js,mjs}',
      'eslint.config.js',
    ],
    languageOptions: {
      globals: { ...globals.node, ...globals.es2023 },
    },
    rules: {
      'no-console': 'off',
    },
  },

  // Ambient declaration files. `wrangler types` generates exactly this shape —
  // inline `import()` types (a .d.ts cannot have top-level imports without
  // becoming a module) and an interface that only widens its supertype.
  {
    files: ['**/*.d.ts'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },
);
