import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // PaymentEvent is append-only and lib/paymentLog.ts is the only place
    // allowed to write to it (see that file). This turns "nothing else may
    // call prisma.paymentEvent.create" from a comment into a lint error.
    files: ["**/*.{ts,tsx}"],
    ignores: ["lib/paymentLog.ts", "lib/paymentLog.test.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.object.property.name='paymentEvent'][callee.property.name='create']",
          message:
            "Only lib/paymentLog.ts may call prisma.paymentEvent.create — use appendPaymentEvent instead.",
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
  ]),
]);

export default eslintConfig;
