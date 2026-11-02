import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", ".test-build/**", ".vscode-test/**", "node_modules/**", "test-fixtures/**", "*.vsix", "old/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["*.mjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly" } },
  },
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
);
