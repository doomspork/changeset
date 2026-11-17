# changeset

Validated, constraint-aware writes for TypeScript ORMs. Ships with a Prisma adapter and an in-memory adapter; has no
runtime dependencies.

A **changeset** is a proposed write to one row. It holds the row as stored (`data`, or null for an insert), the
columns the write would change (`changes`), and every problem with it (`errors`, by column). Untrusted input enters
through `cast`, which reads only the columns you permit and parses each with that column's schema; trusted values
enter through `change` and `putChange`. Validators add errors and never throw, so a caller gets every problem at
once. A **repo** runs a valid changeset through an adapter, and turns a database constraint you declared (unique,
foreign key, check) into a field error instead of an exception.

Instead of one function per form, field and status change, a model gets a few named changesets (`create`, `rename`,
`status`, `archive`) and every write goes through the same pipeline.

```sh
pnpm add changeset
```

Node 22+, ESM only. Field schemas are anything that implements [Standard Schema](https://standardschema.dev): zod
3.24+ and 4, valibot, arktype.

| Entry point          | What                                                    |
| -------------------- | ------------------------------------------------------- |
| `changeset`          | `Changeset`, `cast`, validators, `repo`, `unwrap`        |
| `changeset/prisma`   | `prismaAdapter`, `prismaViolation`                       |
| `changeset/memory`   | `memoryAdapter`, an in-memory table for tests            |
| `changeset/testing`  | `adapterContract`, the test suite every adapter passes   |

## Quick start with Prisma

```ts
import { z } from 'zod';
import { Changeset, type Fields, repo, unwrap } from 'changeset';
import { prismaAdapter, type PrismaRow } from 'changeset/prisma';
import type { PrismaClient } from './generated/prisma/client';

type Project = PrismaRow<PrismaClient['project']>;

// One schema per column a user may set. A schema whose output doesn't match the column's type is a compile error.
const fields = {
  name: z.string().trim().min(1).max(120),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9-]+$/),
  description: z.string().max(2000).nullable()
} satisfies Fields<Project>;

const projectChangesets = {
  create: (attrs: unknown, owner: { accountId: string; ownerId: string }) =>
    Changeset.of<Project>(null)
      .cast(attrs, fields, ['name', 'slug', 'description'])
      .change(owner)
      .validateRequired(['name', 'slug'])
      .uniqueConstraint('slug', ['accountId', 'slug']),
  edit: (project: Project, attrs: unknown) =>
    Changeset.of(project)
      .cast(attrs, fields, ['name', 'slug', 'description'])
      .validateRequired(['name', 'slug'])
      .uniqueConstraint('slug', ['accountId', 'slug'])
};

// Row, where and context types are inferred from the delegate.
const projects = repo({
  adapter: (prisma: PrismaClient) => prismaAdapter(prisma.project),
  find: (id: string) => ({ id })
});

const result = await projects.insert(() => projectChangesets.create(req.body, owner), prisma);
if (!result.ok) return res.status(422).json(result.changeset.errors);
// { slug: [{ message: 'has already been taken', code: 'unique' }] }

const project = unwrap(await projects.update(id, (row) => projectChangesets.edit(row, req.body), prisma));
```

## A multi-tenant app

Tenancy, ownership and permissions aren't built in. They're the app's rules, expressed through the repo's options:

- `find` scopes every read and write;
- `stamp` sets columns from the session;
- `authorize` refuses writes;
- `protect` guards columns no changeset may touch.

The full version is in [`examples/multi-tenant.ts`](examples/multi-tenant.ts), with end-to-end tests against
Postgres.

```ts
const PROTECTED = ['id', 'accountId', 'ownerId', 'createdAt', 'updatedAt'] as const;

// Field schemas may not name a protected column: `{ accountId: z.string() } satisfies AppFields<Project>` fails to compile.
type AppFields<T extends object> = Fields<T, Exclude<Field<T>, (typeof PROTECTED)[number]>>;

const projects = repo({
  adapter: ({ db }: AppContext) => prismaAdapter(db.project),
  // Another account's row reads as missing: the tenant is part of every where.
  find: (id: string, { session }) => ({ id, accountId: session.accountId }),
  authorize: (action, { session }) => {
    if (!session.can(action === 'delete' ? 'projects:delete' : 'projects:write')) throw new ForbiddenError();
  },
  // Laid over the changes, so they always win.
  stamp: { insert: ({ session }) => ({ accountId: session.accountId, ownerId: session.userId }) },
  // A changeset that changes one of these throws, whichever way the change got in.
  protect: PROTECTED,
  // An update or delete must still match the updatedAt it read.
  lock: ['updatedAt'],
  afterWrite: async (row, changeset, { db, session }, action) => {
    // JSON round trip: Prisma's Json input doesn't take Date values.
    const diff = JSON.parse(JSON.stringify(changeset.diff()));
    await db.auditEntry.create({ data: { projectId: row.id, actorId: session.userId, action, diff } });
  },
  notFound: () => new ProjectNotFoundError()
});

const STATUS_FLOW = { draft: ['active', 'archived'], active: ['archived'], archived: ['active'] } as const;

export const projectChangesets = {
  create: (attrs: unknown) =>
    Changeset.of<Project>(null)
      .cast(attrs, projectFields, ['name', 'slug'])
      .putChange('status', 'draft')
      .validateRequired(['name', 'slug'])
      .uniqueConstraint('slug', ['accountId', 'slug']),
  status: (row: Project, attrs: unknown) =>
    Changeset.of(row).cast(attrs, projectFields, ['status']).validateRequired(['status']).validateTransition('status', STATUS_FLOW),
  archive: (row: Project) => Changeset.of(row).putChange('status', 'archived').validateTransition('status', STATUS_FLOW),
  remove: (row: Project) =>
    Changeset.of(row).check('base', ({ data }) => (data?.status === 'archived' ? null : 'archive the project first'), 'restrict')
};

export const createProject = (attrs: unknown, ctx: AppContext) => projects.insert(() => projectChangesets.create(attrs), ctx);
export const setStatus = (id: string, attrs: unknown, ctx: AppContext) => projects.update(id, (row) => projectChangesets.status(row, attrs), ctx);
export const archiveProject = (id: string, ctx: AppContext) => projects.update(id, (row) => projectChangesets.archive(row), ctx);
export const deleteProject = (id: string, ctx: AppContext) => projects.delete(id, (row) => projectChangesets.remove(row), ctx);
```

## Changesets

```ts
Changeset.of<Row>(null)   // an insert
Changeset.of(row)         // an update (or a delete's checks) over the stored row
```

A changeset is immutable: each method returns a new one. Read it with:

- `data`, `changes` and `errors`;
- `valid` and `changed`;
- `action`, which is `'insert'` or `'update'`;
- `getField(key)`, the change if there is one, else the stored value;
- `getChange(key)`;
- `diff()`, which returns `{ column: { from, to } }`, the payload for an audit entry.

### `cast`: untrusted input

```ts
changeset.cast(attrs, fields, permitted)
cast(data, attrs, fields, permitted)   // the same, as a function
```

- **Unpermitted keys are ignored.** Only keys listed in `permitted` are read. A permitted key with no schema is a
  compile error.
- **Each value is parsed by its column's schema.** The parsed value is the change. A parse failure is an error with
  the schema's message and code `invalid`.
- **Blank text becomes null before parsing**, so a cleared form field clears a nullable column. Blank into a column
  whose schema rejects null is `can't be blank` (code `required`).
- **A value equal to the stored one is not a change.** Dates compare by time, and JSON, arrays and byte arrays by
  content.
- **An omitted key leaves its column alone.** A key whose value is `undefined` counts as omitted.
- **An update with no changes doesn't write.** The repo returns the stored row.
- **Attributes must be an object.** Anything else is a `base` error.
- **Schemas must be synchronous.** An async check (a lookup) belongs in a `prepare` step.

The raw attributes are kept on `changeset.params`, so `castEmbed` can read a JSON column from them.

For an insert, `T` can't be inferred from `null`, so write `Changeset.of<Row>(null).cast(...)`.

### `castEmbed`: a JSON column

```ts
Changeset.of(row)
  .cast(attrs, fields, ['name'])
  .castEmbed('address', { line1: z.string(), city: z.string(), zip: z.string().nullable() }, ['line1', 'city', 'zip'])
```

`castEmbed` reads `attrs.address` as an object, by the same rules as `cast`:

- **Only the subkeys present change.** The others keep their stored values.
- **Nested errors are keyed by path**, such as `address.city`.
- **A value that isn't an object** is an error on `address`.
- **Subkey schemas are typed** from the column's object type. A Prisma `Json` column accepts any subkeys with
  JSON-valued schemas.

### `change` and `putChange`: trusted values

```ts
change(row, { status: 'archived', archivedAt: new Date() })
changeset.change({ ... })
changeset.putChange('status', 'archived')
changeset.updateChange('email', (email) => email.toLowerCase())   // only if it changed
changeset.deleteChange('slug')
```

These values aren't parsed. A value equal to the stored one is still not a change.

### Validators

Each adds an error and never throws. Except for `validateRequired` and `check`, a validator runs only when its
column changed and has no error yet.

| Validator                                       | Code         | Default message                     |
| ----------------------------------------------- | ------------ | ----------------------------------- |
| `validateRequired(keys)`                        | `required`   | `can't be blank`                    |
| `validateChange(key, (value, cs) => msg \| null, code?)` | your code (`invalid`) | yours                 |
| `validateInclusion(key, values)`                | `inclusion`  | `is invalid`                        |
| `validateExclusion(key, values)`                | `exclusion`  | `is reserved`                       |
| `validateFormat(key, regex)`                    | `format`     | `has invalid format`                |
| `validateLength(key, { min, max, is })`         | `length`     | `should be at least 3 long`, …      |
| `validateNumber(key, { gt, gte, lt, lte })`     | `number`     | `should be greater than 0`, …       |
| `validateTransition(key, allowed)`              | `transition` | `can't change from active to draft` |
| `check(key, (cs) => msg \| null, code?)`        | your code (`invalid`) | yours                      |

Notes on individual validators:

- **Custom messages:** each validator except the two custom ones takes `{ message }`.
- **`validateRequired`** checks the value the row will have, whether it changed or not.
- **`validateLength`** counts characters, not UTF-16 units, and also works on arrays.
- **`validateFormat`, `validateLength` and `validateNumber`** skip null, which is `validateRequired`'s job.
- **`validateTransition`** takes a state machine, `{ from: [to, ...] }`. On an update, a change the stored state
  can't reach is an error. On an insert, the row may start in any state the map has a key for. A state the column's
  type doesn't have is a compile error.
- **`check`** is a rule over the whole changeset, changed or not: a rule across columns, or a delete's restriction.
- **`addError(key, message, code?)`** adds an error directly. `key` is a column, `base`, or a path such as
  `address.city`.

### Constraint declarations

A database constraint failure is an exception unless the changeset declares it. A declared failure becomes a field
error, and the write returns `{ ok: false }`.

```ts
changeset
  .uniqueConstraint('slug', ['accountId', 'slug'])              // by the constraint's columns
  .uniqueConstraint('email', 'users_email_key')                 // or by its name
  .foreignKeyConstraint('ownerId')                              // columns default to [field]
  .checkConstraint('priority', 'projects_priority_check', { message: 'must be 0 to 10' })
```

- **By columns:** matches when the reported columns are exactly the declared ones, in any order.
- **By name:** matches the reported constraint name.
- **Error codes:** `unique`, `foreign_key` and `check`. The default messages are `has already been taken`,
  `does not exist` and `is invalid`.
- **Restricted deletes:** a delete blocked by another table's foreign key is reported by name only, so declare it by
  name:
  `foreignKeyConstraint('id', 'projects_owner_id_fkey', { message: 'still owns projects' })`.

### `prepare`: async steps inside the write

```ts
changeset.prepare<Ctx>(async (changeset, ctx) => {
  const taken = await ctx.db.reservedSlug.findUnique({ where: { slug: changeset.getField('slug') } });
  return taken ? changeset.addError('slug', 'is reserved') : changeset;
})
```

- **When steps run:** after validation passes, in the order declared, with the repo's context.
- **What a step can do:** add changes or errors. An error stops the write.
- **Protected columns:** checked again after the steps run.
- **Nesting:** a step declared from inside another step doesn't run.

### `errorMessages` and `unwrap`

`errorMessages(changeset)` flattens the errors into `['slug has already been taken', ...]`.

`unwrap(result)` returns the row, or throws a `ChangesetError` carrying the changeset. To throw your own error type
instead, pass a function: `unwrap(result, (cs) => new HttpError(422, cs.errors))`.

## Repos

```ts
const things = repo({ adapter, find, authorize?, stamp?, protect?, lock?, afterWrite?, notFound? });

await things.insert((ctx) => changeset, ctx);
await things.update(key, (row, ctx) => changeset, ctx);
await things.delete(key, (row, ctx) => changeset, ctx);
// → { ok: true, row, changeset } | { ok: false, changeset }
```

| Option       | What                                                                                                        |
| ------------ | ----------------------------------------------------------------------------------------------------------- |
| `adapter`    | `(ctx) => Adapter`. Built per call, so it can use a transaction handle from the context.                    |
| `find`       | `(key, ctx) => where`. Finds one row, including anything every write must match (a tenant, an owner).       |
| `authorize`  | `(action, ctx)`. Throws to refuse; runs before anything else. `action` is `insert`, `update` or `delete`.   |
| `stamp`      | `{ insert?(ctx), update?(ctx) }`. Columns set from the context, laid over the changes, so they always win.  |
| `protect`    | Columns no changeset may change, by `cast`, `putChange` or a `prepare` step. A change throws `ProtectedColumnError`. Stamps may still set them. |
| `lock`       | Columns whose stored values an update or delete must still match, such as `updatedAt`. When the row changed since it was read, the result is a `base` error with code `stale`. |
| `afterWrite` | `(row, changeset, ctx, action)`. Runs after each successful write, on the same context. Not run for a no-op update. Its errors propagate. |
| `notFound`   | `(key, ctx) => Error`. What a missing row throws; `NotFoundError` by default.                               |

How the three operations behave:

- **`update`:** finds the row with `find`, builds the changeset over it, and writes with the same `where`. A valid
  changeset with no changes doesn't write.
- **`delete`:** builds a changeset over the row that carries only checks, such as `check` or `foreignKeyConstraint`.
  A delete changeset that changes a column throws. On success, `row` is the row as it was.
- **Typing:** `find`'s return type must be the adapter's `where`. With `prismaAdapter`, that is the model's unique
  `where`.

### Transactions

The library never opens a transaction. Writes that must land together run on a transaction handle that the caller
puts in the context; the repo builds its adapter from it per call.

```ts
await prisma.$transaction(async (tx) => {
  const ctx = { db: tx, session };
  const project = unwrap(await createProject(attrs, ctx));
  unwrap(await createProject(otherAttrs, ctx));   // a ChangesetError here rolls back both
});
```

An `afterWrite` audit entry written with `ctx.db` lands in the same transaction.

In Postgres, a failed statement aborts its transaction. When a constraint failure inside a transaction becomes a
field error, end the transaction: `unwrap` the result so the error rolls it back.

## Adapters

```ts
interface Adapter<Row, Where> {
  findOne(where: Where): Promise<Row | null>;
  insert(data: Partial<Row>): Promise<Row>;
  update(where: Where, data: Partial<Row>): Promise<Row | null>;   // null when nothing matched
  remove(where: Where): Promise<Row | null>;                       // null when nothing matched
  narrow(where: Where, values: Partial<Row>): Where;               // for `lock`
  violation(error: unknown): ConstraintViolation | null;           // { kind, constraint?, columns? }
}
```

The contract requires two things beyond these signatures:

- **Fresh rows:** every row an adapter returns is a fresh object.
- **`violation`'s columns** are this table's columns that the constraint covers, as row keys, not database column
  names.

### Prisma

```ts
import { prismaAdapter } from 'changeset/prisma';

prismaAdapter(prisma.project)   // or tx.project
```

- **Types:** the row, `where`, create and update types are read from the generated delegate, with no type
  arguments. `PrismaRow<typeof prisma.project>` names the row type.
- **`where`:** a unique `where`, which may carry filters on other columns (`{ id, accountId }`). A row the extra
  filter excludes reads as missing.
- **No Prisma import:** the adapter imports nothing from Prisma.
- **Tested setups:** Prisma 6.19 and 7.10, with both the `prisma-client-js` and `prisma-client` generators, with and
  without a driver adapter.

What each setup reports, verified against Postgres:

| Failure          | Prisma 6 (query engine; also with a driver adapter)          | Prisma 7 (driver adapter)                                        |
| ---------------- | ------------------------------------------------------------- | ---------------------------------------------------------------- |
| unique           | `P2002`, `meta.target`: database column names                 | `P2002`, `meta.driverAdapterError.cause.constraint.index`: name  |
| foreign key      | `P2003`, `meta.constraint`: name                              | `P2003`, `cause.constraint.index`: name                          |
| check            | `PrismaClientUnknownRequestError`; name only in the message   | `P2039`, `cause.originalCode` `23514`; name in `originalMessage` |
| not found        | `P2025` (the adapter returns null)                            | `P2025` (the adapter returns null)                               |

`prismaAdapter` reads the model's table and column names from the client's runtime model, through the delegate's
`$name` and `$parent`. With them it does two things:

- it maps database columns to field names (`account_id` → `accountId`);
- it derives columns from a constraint's default name (`projects_account_id_slug_key` → `['accountId', 'slug']`).

So a declaration by columns works on both versions. A constraint with a custom name (`@@unique(..., map: "...")`)
has no derivable columns: declare it by name. If a client doesn't expose its runtime model, pass
`prismaAdapter(delegate, { model })`. `prismaViolation(error, model?)` is the same normalization on its own.

**Json columns:** Prisma rejects a plain `null` for a `Json` column. Set `Prisma.JsonNull` or `Prisma.DbNull`
explicitly.

### Memory

```ts
import { memoryAdapter } from 'changeset/memory';

const projects = memoryAdapter<Project>({
  rows: [],                                             // shared with the caller
  defaults: (data) => ({ id: crypto.randomUUID(), status: 'draft', ...data }) as Project,
  onUpdate: () => ({ updatedAt: new Date() }),
  unique: [{ name: 'projects_account_id_slug_key', columns: ['accountId', 'slug'] }],
  foreignKeys: [{ columns: ['ownerId'], references: () => users }],
  referencedBy: [{ name: 'tasks_project_id_fkey', rows: () => tasks, columns: ['projectId'] }],
  checks: [{ name: 'projects_priority_check', columns: ['priority'], test: (row) => row.priority >= 0 }]
});
```

An in-memory table for tests. Its `where` is a partial row, matched by equality. Constraints behave as they do in
SQL: null never conflicts and never fails a foreign key, and a failure leaves the table unchanged.

### Writing an adapter

Implement `Adapter<Row, Where>`, then run the contract suite. It takes your runner's `describe`, `it` and
`beforeEach`, so it works with vitest, jest, mocha or `node:test`:

```ts
import { beforeEach, describe, it } from 'vitest';
import { adapterContract } from 'changeset/testing';

adapterContract('my adapter', {
  adapter: () => myAdapter(db, items),
  reset: () => db.items.deleteAll(),
  where: (values) => toMyWhere(values),   // equality on every column given
  constraints: { unique: 'items_sku_key', foreignKey: 'items_parent_id_fkey', check: 'items_qty_check' }
}, { describe, it, beforeEach });
```

The suite runs against an `items` table you create:

- a generated string `id`;
- a unique `sku`;
- `name`;
- `qty`, defaulting to 0, with a check that it is at least 0;
- `parentId`, a self-referencing foreign key that restricts deletes.

It checks reads and writes, fresh objects, `narrow`, each kind of violation, and a repo on top. Leave `check` out if
your setup can't report check violations. [`DRIZZLE.md`](DRIZZLE.md) works through a Drizzle adapter.

## Development

```sh
pnpm install          # also generates the test Prisma clients
pnpm db:up            # Postgres on localhost:54329, from docker-compose.yml
pnpm typecheck
pnpm test             # unit and integration; `pnpm test:unit` without Postgres
pnpm build
```

The test Prisma schema is `test/prisma/models.prisma`. `test/prisma/v6` and `test/prisma/v7` each generate clients
for their Prisma major. `PRISMA_SETUPS=v7-client,v6-engine` narrows which setups the integration tests run.

## License

MIT
