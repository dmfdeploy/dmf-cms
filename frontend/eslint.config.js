import jsxA11y from "eslint-plugin-jsx-a11y";
import tseslint from "typescript-eslint";
import globals from "globals";

// No-op stand-in so existing "eslint-disable react-hooks/..." comments
// resolve without loading the react-hooks plugin.
const reactHooksStub = {
  rules: { "exhaustive-deps": { meta: { schema: [] }, create: () => ({}) } },
};

export default [
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "test-results/**",
      "playwright-report/**",
      "blob-report/**",
    ],
  },
  {
    files: ["**/*.{js,jsx,ts,tsx}"],
    ...jsxA11y.flatConfigs.recommended,
    languageOptions: {
      ...jsxA11y.flatConfigs.recommended.languageOptions,
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser },
    },
    plugins: { ...jsxA11y.flatConfigs.recommended.plugins, "react-hooks": reactHooksStub },
    linterOptions: {
      // Existing disable comments name rules from plugins we do not load.
      reportUnusedDisableDirectives: "off",
    },
  },
  {
    // Downgraded to warnings to keep the debt visible without blocking CI.
    // Restore the recommended level when dmfdeploy/dmfdeploy#614 is fixed.
    files: ["**/*.{js,jsx,ts,tsx}"],
    rules: {
      "jsx-a11y/click-events-have-key-events": "warn",
      "jsx-a11y/no-noninteractive-element-interactions": "warn",
      "jsx-a11y/no-static-element-interactions": "warn",
    },
  },
];
