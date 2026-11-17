# AGENTS.md

Guidance for coding agents working in this repository. The user-facing docs are [`README.md`](README.md) and
[`DRIZZLE.md`](DRIZZLE.md). Read the README before changing behavior: it is the library's specification.

## What this is

`changeset` is a TypeScript library for validated, constraint-aware writes to one row through an ORM. The three parts are:

- **Changesets** (`src/changeset.ts`): immutable values built by `cast`, `change` and validators.
- **Repos** (`src/repo.ts`): run a changeset through an adapter and map constraint failures to field errors.
- **Adapters**: Prisma (`src/adapters/prisma.ts`) and in-memory (`src/adapters/memory.ts`).

The package name is provisional: `changeset` on npm is another package. Don't publish, and don't tell anyone to
install it from npm.

## Commands

Node 22+ and pnpm 10 (pinned in `packageManager`). ESM only.

```sh
pnpm install          # also generates five test Prisma clients (prepare -> test/prisma/generate.mjs)
pnpm typecheck        # tsc over src, test, examples; includes the compile-time tests in test/types
pnpm test:unit        # no database needed
pnpm db:up            # Postgres 17 on localhost:54329 (docker-compose.yml)
pnpm test             # unit + integration; integration needs Postgres
pnpm build            # emits dist/ from tsconfig.build.json
```

- **Narrowing setups:** `PRISMA_SETUPS=v7-client,v6-engine pnpm test` runs a subset of the Prisma setups. The full
  list is `v6-engine`, `v6-adapter`, `v6-client`, `v7-client` and `v7-js`, defined in `test/prisma/setups.mjs`.
  This variable also narrows client generation.
- **Database URL:** `DATABASE_URL` overrides the default
  `postgresql://changeset:changeset@localhost:54329/changeset_test`.
- **No database:** without one, run `pnpm typecheck` and `pnpm test:unit`, and say that integration tests weren't
  run.

## Hard rules

The tests enforce these:

- **No runtime dependencies.** `package.json` has no `dependencies`. Nothing under `src/` imports a package at
  runtime; type-only imports are fine. See `test/guardrails.test.ts`.
- **The core imports no adapter.** Files directly in `src/` may import only sibling files (`./x.js`), never
  `./adapters/*` or `./testing/*`.
- **The Prisma adapter imports nothing from Prisma.** It reads the client's runtime model through the delegate's
  `$name` and `$parent`.
- **Every adapter passes `adapterContract`.** It lives in `src/testing/contract.ts`, and the memory and Prisma
  adapters run it. A change to adapter semantics changes the contract first, and then every adapter.
- **Compile-time behavior is tested.** `test/types/*.ts` uses `@ts-expect-error`, so `pnpm typecheck` fails if a
  type stops rejecting something. When you change public types, update these files.

## Conventions

- **Imports:** relative imports use the `.js` extension (NodeNext), and type-only imports use `import type`
  (`verbatimModuleSyntax`).
- **Style:** there is no formatter or linter config. Match the surrounding code: 2-space indent, single quotes,
  semicolons, no trailing commas. Lines run long (up to about 160 characters) rather than wrapping.
- **Errors:**
  - Validators add errors and never throw.
  - Programming errors throw, such as `ProtectedColumnError` or a delete changeset that changes a column.
  - Invalid input never throws; it becomes `{ ok: false, changeset }`.
- **Changesets are immutable.** Every method returns a new changeset.
- **Examples:** files in `examples/` are type-checked and have end-to-end tests in `test/integration/`. Keep them
  compiling.
- **Postgres error shapes:** facts about what Postgres or Prisma reports belong in the README or `DRIZZLE.md` only
  once they've been observed against a real database. Don't record them from memory.

## Docs

When a change alters public behavior, update `README.md` in the same change. `DRIZZLE.md` is a plan for an
adapter that doesn't exist yet, so keep it labeled that way.

## Commits and releases

- **Commit messages:** use [Conventional Commits](https://www.conventionalcommits.org): `feat:`, `fix:`, `docs:`,
  `test:`, `ci:`, `chore:`, with an optional scope.
- **Releases:** release-please builds `CHANGELOG.md` and version bumps from these messages, so the type matters.
  Don't edit `CHANGELOG.md` or the version by hand.
- **CI:** `.github/workflows/ci.yml` runs typecheck, tests against Postgres, and the build on Node 22 and 24. It then
  loads every entry point from `dist`.
