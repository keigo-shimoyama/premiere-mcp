/**
 * Adobe's own lint rules for the premierepro UXP API.
 *
 * They encode the constraints this project learned the hard way: actions must
 * be built inside `lockedAccess`, must not escape that scope, and callbacks
 * passed to `lockedAccess` / `executeTransaction` must be synchronous. See
 * docs/api-traps.md §1 and §3 — the rules and the traps describe the same
 * failures, and the linter catches them before Premiere does.
 */
import premierepro from "@adobe/eslint-plugin-premierepro";

export default [
  {
    files: ["panel/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        require: "readonly", document: "readonly", window: "readonly",
        console: "readonly", setTimeout: "readonly", clearTimeout: "readonly",
        WebSocket: "readonly", JSON: "readonly", Promise: "readonly",
      },
    },
    plugins: { "@adobe/premierepro": premierepro },
    rules: {
      "@adobe/premierepro/no-action-scope-escape": "error",
      "@adobe/premierepro/require-action-lock-scope": "error",
      "@adobe/premierepro/no-async-in-locked-access": "error",
      "@adobe/premierepro/no-async-in-execute-transaction": "error",
      "@adobe/premierepro/require-execute-transaction": "error",
      "@adobe/premierepro/prefer-locked-access-wrapper": "warn",
      "@adobe/premierepro/prefer-undo-string": "warn",
    },
  },
];
