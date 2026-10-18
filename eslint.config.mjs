import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // No test draws a page or a component, so a value read before it is
    // declared, as in a callback run at once, would throw only when one is.
    files: ["src/app/**/*.tsx"],
    rules: {
      "@typescript-eslint/no-use-before-define": [
        "error",
        {
          functions: false,
          classes: true,
          variables: true,
          enums: true,
          typedefs: false,
          ignoreTypeReferences: true,
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Generated reports.
    "coverage/**",
    "playwright-report/**",
    "test-results/**",
  ]),
]);

export default eslintConfig;
