/** @type {import('dependency-cruiser').IConfiguration} */
const config = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular dependencies are not allowed in the monorepo.',
      from: {},
      to: {
        circular: true,
      },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      comment: 'This file has no relations with other files in the source tree.',
      from: {
        orphan: true,
      },
      to: {},
    },
    {
      name: 'no-packages-importing-apps',
      severity: 'error',
      comment:
        'Shared packages must never import from apps. Dependency direction must be downward only.',
      from: {
        path: '^packages/([^/]+)/src/.+',
      },
      to: {
        path: '^apps/',
      },
    },
    {
      name: 'generators-must-be-pure',
      severity: 'error',
      comment:
        'Generators must be pure and can only import shared, ips, or config. No I/O, database, queue, registry or auth imports allowed.',
      from: {
        path: '^packages/generators/([^/]+)/src/.+',
      },
      to: {
        path: '^packages/([^/]+)',
        // A generator may import shared/ips/config and its own package's files.
        pathNot: '^packages/(shared|ips|config|generators)',
      },
    },
    {
      name: 'ips-must-be-independent',
      severity: 'error',
      comment: 'The IPS package represents the core data contract and must only import shared.',
      from: {
        path: '^packages/ips/src/.+',
      },
      to: {
        path: '^packages/([^/]+)',
        // IPS may import shared and its own package's files.
        pathNot: '^packages/(shared|ips)',
      },
    },
    {
      name: 'parsers-must-be-pure',
      severity: 'error',
      comment:
        'Parsers must only import shared or ips. They should not import queue, db, registry, or apps.',
      from: {
        path: '^packages/parsers/src/.+',
      },
      to: {
        path: '^packages/([^/]+)',
        // Parsers may import shared/ips and their own package's files.
        pathNot: '^packages/(shared|ips|parsers)',
      },
    },
    {
      name: 'web-must-not-import-server',
      severity: 'error',
      comment:
        'The web app (apps/web) must not import server packages like db, queue, registry, auth, or generators. It must only communicate via HTTP API.',
      from: {
        path: '^apps/web/src/.+',
      },
      to: {
        path: '^(packages|apps)/([^/]+)',
        // The web app may import shared/ui and its own files — nothing server-side.
        pathNot: '^(packages/shared|packages/ui|apps/web)',
      },
    },
  ],
  options: {
    doNotFollow: {
      path: 'node_modules',
    },
    exclude: {
      path: ['dist', String.raw`\.next`, '.test-tmp'],
    },
    tsPreCompilationDeps: true,
    tsConfig: {
      fileName: 'tsconfig.json',
    },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
    reporterOptions: {
      text: {
        highlightFocused: true,
      },
    },
  },
};

export default config;
