import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
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
  // Map.tsx keeps a hand-maintained dependency list that it documents as load-bearing
  // ("every rendered input has to be listed here or its layer silently stops updating"),
  // and nothing was checking it.
  reactHooks.configs.flat.recommended,
  {
    rules: {
      // Advisory here rather than blocking. The map and the state hooks deliberately talk
      // to React through refs written during render and effects that run once; that is
      // documented where it happens and is safe as this app is written (no transitions, no
      // Suspense). These warnings are the list of places to revisit if that ever changes —
      // not a licence to add more.
      "react-hooks/exhaustive-deps": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/set-state-in-effect": "warn",
      // Same pattern seen from the other side: the routing worker is held in a ref and
      // driven imperatively, which this rule reads as mutating an effect dependency.
      "react-hooks/immutability": "warn",
      "@typescript-eslint/no-explicit-any": "off",
      // `const { dropped, ...rest } = value` is how a key is omitted.
      "@typescript-eslint/no-unused-vars": ["error", { ignoreRestSiblings: true }],
    },
  },
);
