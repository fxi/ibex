import tseslint from "typescript-eslint";
export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "public/**",
      "data/**",
      "playwright-report/**",
      "test-results/**",
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      // `const { dropped, ...rest } = value` is how a key is omitted.
      "@typescript-eslint/no-unused-vars": ["error", { ignoreRestSiblings: true }],
    },
  },
);
