import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const adminTestFiles = [
  "app/admin/**/tests/**",
  "app/admin/**/*.test.*",
  "app/admin/**/*.spec.*",
];

const authTestFiles = [
  "app/auth/**/tests/**",
  "app/auth/**/*.test.*",
  "app/auth/**/*.spec.*",
];

const databaseImports = [
  "@/db",
  "@/db/**",
  "**/db",
  "**/db/**",
  "drizzle-orm",
  "drizzle-orm/**",
];

const serviceDatabaseImports = [
  "@/db/**",
  "**/db/**",
  "../**/db",
  "./**/db",
  "drizzle-orm",
  "drizzle-orm/**",
];

const modelImports = [
  "@/shared/models",
  "@/shared/models/**",
  "**/models",
  "**/models/**",
  "**/shared/models",
  "**/shared/models/**",
];

const policyImports = [
  "@/shared/policies",
  "@/shared/policies/**",
  "**/policies",
  "**/policies/**",
  "**/shared/policies",
  "**/shared/policies/**",
];

const integrationImports = [
  "@/shared/integrations",
  "@/shared/integrations/**",
  "**/integrations",
  "**/integrations/**",
  "**/shared/integrations",
  "**/shared/integrations/**",
];

const actionImports = [
  "**/actions/**",
  "**/*.action",
  "**/*.action.*",
];

const presentationRestrictedImports = [
  {
    group: ["**/*.service", "**/*.service.*"],
    message:
      "Presentation must use Controller entry points, not Services directly.",
  },
  {
    group: policyImports,
    message: "Presentation cannot import Policies.",
  },
  {
    group: modelImports,
    message: "Presentation cannot import Models.",
  },
  {
    group: databaseImports,
    message: "Presentation cannot import Drizzle or database modules.",
  },
  {
    group: integrationImports,
    message: "Presentation cannot import Integrations.",
  },
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    name: "admin/presentation-boundaries",
    files: [
      "app/admin/**/*.tsx",
      "app/admin/**/*.hook.ts",
      "app/admin/**/use-*.ts",
      "app/admin/**/*.query.ts",
      "app/admin/**/*.mutation.ts",
      "app/admin/**/state.ts",
    ],
    ignores: [
      ...adminTestFiles,
      "app/admin/**/*.action.*",
      "app/admin/**/actions/**",
      "app/admin/**/*.service.*",
      "app/admin/**/routes/**",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: presentationRestrictedImports,
        },
      ],
    },
  },
  {
    name: "admin/component-boundaries",
    files: [
      "app/admin/**/*.tsx",
      "app/admin/**/components/**/*.ts",
    ],
    ignores: [
      ...adminTestFiles,
      "app/admin/**/*.action.*",
      "app/admin/**/actions/**",
      "app/admin/**/*.service.*",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "jotai",
              message:
                "Admin components consume state and handlers through public Hooks; do not import Jotai directly.",
            },
          ],
          patterns: [
            ...presentationRestrictedImports,
            {
              group: ["jotai/**"],
              message:
                "Admin components consume state and handlers through public Hooks; do not import Jotai directly.",
            },
            {
              group: actionImports,
              message:
                "Admin components must call public Hooks instead of importing Actions directly.",
            },
          ],
        },
      ],
    },
  },
  {
    name: "auth/presentation-boundaries",
    files: [
      "app/auth/**/*.tsx",
      "app/auth/**/*.hook.ts",
      "app/auth/**/use-*.ts",
      "app/auth/**/*.query.ts",
      "app/auth/**/*.mutation.ts",
      "app/auth/**/state.ts",
    ],
    ignores: [
      ...authTestFiles,
      "app/auth/**/*.action.*",
      "app/auth/**/actions/**",
      "app/auth/**/route.ts",
      "app/auth/**/*-action.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: presentationRestrictedImports,
        },
      ],
    },
  },
  {
    name: "auth/component-boundaries",
    files: ["app/auth/**/*.tsx", "app/auth/**/components/**/*.ts"],
    ignores: [
      ...authTestFiles,
      "app/auth/**/*.action.*",
      "app/auth/**/actions/**",
      "app/auth/**/route.ts",
      "app/auth/**/*-action.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "jotai",
              message:
                "Auth components consume state and handlers through public Hooks; do not import Jotai directly.",
            },
          ],
          patterns: [
            ...presentationRestrictedImports,
            {
              group: ["jotai/**"],
              message:
                "Auth components consume state and handlers through public Hooks; do not import Jotai directly.",
            },
            {
              group: actionImports,
              message:
                "Auth components must call public Hooks instead of importing behavior Actions directly.",
            },
          ],
        },
      ],
    },
  },
  {
    name: "admin/controller-boundaries",
    files: [
      "app/admin/**/*.action.ts",
      "app/admin/**/actions/**/*.ts",
      "app/admin/**/action-*.ts",
    ],
    ignores: adminTestFiles,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/lib/auth",
              importNames: ["auth"],
              message:
                "Controllers use narrow authentication utilities; provider API calls belong behind Services and Integrations.",
            },
            {
              name: "react",
              message: "Controllers cannot depend on React.",
            },
            {
              name: "react-dom",
              message: "Controllers cannot depend on React.",
            },
            {
              name: "@tanstack/react-query",
              message: "TanStack Query belongs to Presentation, not Controllers.",
            },
            {
              name: "jotai",
              message: "Jotai belongs to Presentation, not Controllers.",
            },
          ],
          patterns: [
            {
              group: databaseImports,
              message:
                "Actions authenticate and call one Service; database access belongs in Models.",
            },
            {
              group: modelImports,
              message:
                "Actions cannot import Models; call the behavior Service instead.",
            },
            {
              group: policyImports,
              message:
                "Actions cannot authorize through Policies; authorization belongs in Services.",
            },
            {
              group: integrationImports,
              message:
                "Actions cannot import Integrations; call the behavior Service instead.",
            },
            {
              group: [
                "react/**",
                "react-dom/**",
                "@tanstack/react-query/**",
                "jotai/**",
                "@/lib/auth/client",
              ],
              message:
                "Controllers cannot import Presentation or client authentication modules.",
            },
          ],
        },
      ],
    },
  },
  {
    name: "authentication/controller-boundaries",
    files: [
      "app/auth/**/*.action.ts",
      "app/auth/**/actions/**/*.ts",
      "app/auth/**/action-*.ts",
      "app/auth/**/*-action.ts",
      "app/auth/**/route.ts",
      "shared/actions/**/*.action.ts",
    ],
    ignores: authTestFiles,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "react",
              message: "Controllers cannot depend on React.",
            },
            {
              name: "react-dom",
              message: "Controllers cannot depend on React.",
            },
            {
              name: "@tanstack/react-query",
              message: "TanStack Query belongs to Presentation, not Controllers.",
            },
            {
              name: "jotai",
              message: "Jotai belongs to Presentation, not Controllers.",
            },
          ],
          patterns: [
            {
              group: databaseImports,
              message:
                "Authentication Controllers may use @/lib/auth directly, but cannot access application persistence.",
            },
            {
              group: modelImports,
              message:
                "Authentication Controllers cannot import Models; introduce a Service when application records are involved.",
            },
            {
              group: policyImports,
              message:
                "Authentication Controllers cannot authorize application records through Policies; introduce a Service.",
            },
            {
              group: integrationImports,
              message:
                "Authentication Controllers may use only the narrow @/lib/auth boundary, not general Integrations.",
            },
            {
              group: [
                "react/**",
                "react-dom/**",
                "@tanstack/react-query/**",
                "jotai/**",
                "@/lib/auth/client",
              ],
              message:
                "Controllers cannot import Presentation or client authentication modules.",
            },
          ],
        },
      ],
    },
  },
  {
    name: "admin/service-boundaries",
    files: ["app/admin/**/*.service.ts"],
    ignores: adminTestFiles,
    rules: {
      "no-restricted-globals": [
        "error",
        {
          name: "Headers",
          message:
            "Services receive plain application values; HTTP headers belong in Controllers or Integrations.",
        },
        {
          name: "Request",
          message:
            "Services receive plain application values; HTTP requests belong in Controllers.",
        },
        {
          name: "Response",
          message:
            "Services return application results; HTTP responses belong in Controllers.",
        },
      ],
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/db",
              allowImportNames: ["withTransaction"],
              message:
                "Services may import only the root transaction facility; direct database access and executor types belong in Infrastructure.",
            },
            {
              name: "next",
              message: "Services cannot depend on Next.js transport APIs.",
            },
            {
              name: "react",
              message: "Services cannot depend on React.",
            },
            {
              name: "react-dom",
              message: "Services cannot depend on React.",
            },
            {
              name: "@tanstack/react-query",
              message: "TanStack Query belongs to Presentation, not Services.",
            },
            {
              name: "@tanstack/query-core",
              message: "TanStack Query belongs to Presentation, not Services.",
            },
            {
              name: "jotai",
              message: "Jotai belongs to Presentation, not Services.",
            },
          ],
          patterns: [
            {
              group: [
                "next/**",
                "react/**",
                "react-dom/**",
                "@tanstack/react-query/**",
                "@tanstack/query-core/**",
                "jotai/**",
              ],
              message:
                "Services cannot import Next.js, React, TanStack Query, or Jotai modules.",
            },
            {
              group: actionImports,
              message: "Services cannot import Controller Actions.",
            },
            {
              group: serviceDatabaseImports,
              message:
                "Services cannot import Drizzle or database modules directly; use Models and the root transaction facility.",
            },
          ],
        },
      ],
    },
  },
  {
    name: "shared/policy-boundaries",
    files: ["shared/policies/**/*.ts"],
    ignores: ["shared/policies/**/tests/**", "shared/policies/**/*.test.*"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "next",
              message: "Policies are pure authorization decisions.",
            },
            {
              name: "react",
              message: "Policies cannot depend on Presentation.",
            },
            {
              name: "@tanstack/react-query",
              message: "Policies cannot depend on Presentation cache state.",
            },
            {
              name: "jotai",
              message: "Policies cannot depend on Presentation state.",
            },
          ],
          patterns: [
            {
              group: databaseImports,
              message: "Policies cannot query or mutate the database.",
            },
            {
              group: integrationImports,
              message: "Policies cannot call Integrations.",
            },
            {
              group: modelImports,
              allowTypeImports: true,
              message:
                "Policies may import Model record types only; persistence belongs in Services and Models.",
            },
            {
              group: [
                "@/app/**",
                "**/*.action",
                "**/*.action.*",
                "**/*.service",
                "**/*.service.*",
                "next/**",
                "react/**",
                "@tanstack/**",
                "jotai/**",
              ],
              message:
                "Policies cannot depend on Controllers, Services, or Presentation.",
            },
          ],
        },
      ],
    },
  },
  {
    name: "shared/model-boundaries",
    files: ["shared/models/**/*.ts"],
    ignores: ["shared/models/**/tests/**", "shared/models/**/*.test.*"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: policyImports,
              message: "Models cannot authorize through Policies.",
            },
            {
              group: integrationImports,
              message: "Models cannot call Integrations.",
            },
            {
              group: [
                "@/app/**",
                "**/*.action",
                "**/*.action.*",
                "**/*.service",
                "**/*.service.*",
                "next/**",
                "react/**",
                "@tanstack/**",
                "jotai/**",
              ],
              message:
                "Infrastructure Models cannot depend on higher layers.",
            },
          ],
        },
      ],
    },
  },
  {
    name: "shared/integration-boundaries",
    files: ["shared/integrations/**/*.ts"],
    ignores: [
      "shared/integrations/**/tests/**",
      "shared/integrations/**/*.test.*",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: databaseImports,
              message: "Integrations cannot access the application database.",
            },
            {
              group: modelImports,
              message: "Integrations cannot query Models.",
            },
            {
              group: policyImports,
              message: "Integrations cannot authorize through Policies.",
            },
            {
              group: [
                "@/app/**",
                "**/*.action",
                "**/*.action.*",
                "**/*.service",
                "**/*.service.*",
                "next/**",
                "react/**",
                "@tanstack/**",
                "jotai/**",
              ],
              message:
                "Infrastructure Integrations cannot depend on higher layers.",
            },
          ],
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    // The verify server's own build directory (NEXT_DIST_DIR).
    ".next-verify/**",
    ".worktrees/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
