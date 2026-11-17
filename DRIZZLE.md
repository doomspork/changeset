# A Drizzle adapter

How a Drizzle adapter would meet the adapter contract. This package doesn't depend on Drizzle; this is the
plan for `changeset/drizzle`. The code below is a sketch, not compiled against Drizzle.

## The contract

```ts
interface Adapter<Row, Where> {
  findOne(where: Where): Promise<Row | null>;
  insert(data: Partial<Row>): Promise<Row>;
  update(where: Where, data: Partial<Row>): Promise<Row | null>;
  remove(where: Where): Promise<Row | null>;
  narrow(where: Where, values: Partial<Row>): Where;
  violation(error: unknown): ConstraintViolation | null;
}
```

`adapterContract(name, harness, { describe, it, beforeEach })` from `changeset/testing` checks an
implementation against a small `items` table (see `ContractItem` for its columns and constraints).

## Types

An adapter is built per call from a database or transaction handle and one table:

```ts
import type { InferInsertModel, InferSelectModel, SQL } from 'drizzle-orm';
import type { PgDatabase, PgTable } from 'drizzle-orm/pg-core';

function drizzleAdapter<T extends PgTable>(db: PgDatabase<any, any, any>, table: T): Adapter<InferSelectModel<T>, SQL | undefined>;
```

- **Row**: `InferSelectModel<T>`. Keys are the table's TypeScript keys, which is what changesets, field schemas and
  constraint declarations use.
- **Where**: a SQL expression, `SQL | undefined`. A repo's `find` returns one:
  `find: (id, ctx) => and(eq(projects.id, id), eq(projects.accountId, ctx.session.accountId))`.
- **Insert and update data**: `Partial<Row>`, passed to `.values()` and `.set()` as `InferInsertModel<T>`.

The handle can be the database or a transaction (`db.transaction(async (tx) => ...)`), which has the same query
builder. The library never opens a transaction, so the caller passes `tx` in the repo's context and the adapter is
built from it per call.

## Reads and writes

Postgres and SQLite support `RETURNING`, so each write returns the stored row in one statement:

```ts
findOne: async (where) => (await db.select().from(table).where(where).limit(1))[0] ?? null,
insert: async (data) => (await db.insert(table).values(data as InferInsertModel<T>).returning())[0]!,
update: async (where, data) => (await db.update(table).set(data).where(where).returning())[0] ?? null,
remove: async (where) => (await db.delete(table).where(where).returning())[0] ?? null,
```

- **Fresh objects:** each query returns new objects, as the contract requires.
- **One row:** unlike Prisma's unique `where`, nothing in Drizzle's types makes a `where` match at most one row. An
  `update` or `remove` changes every row it matches. `find` must return a `where` on a unique key (plus any tenant
  filter), and the adapter returns the first row returned.
- **MySQL:** no `RETURNING`. Insert with `$returningId()` and read the row back. For update and remove, read the row
  first, then write. A MySQL adapter needs those extra reads, but the contract is unchanged.

## `narrow`, for `lock`

`narrow` adds column equalities to a SQL `where`:

```ts
narrow: (where, values) =>
  and(
    where,
    ...Object.entries(values).map(([key, value]) => {
      const column = getTableColumns(table)[key]!;
      return value === null ? isNull(column) : eq(column, value);
    })
  ),
```

Note `isNull` for null values: `column = NULL` is never true in SQL. Timestamps round-trip as `Date` with the
column's precision, so equality on an `updatedAt` read back from the database holds.

## `violation`

With node-postgres or postgres.js, a constraint failure carries the SQLSTATE `code`, the `constraint` name, the
`table` and a `detail`:

| SQLSTATE | kind          | detail                                                                                                |
| -------- | ------------- | ----------------------------------------------------------------------------------------------------- |
| `23505`  | `unique`      | `Key (account_id, slug)=(…, …) already exists.`                                                       |
| `23503`  | `foreign_key` | Insert or update: `Key (owner_id)=(…) is not present in table "users".` Delete: `Key (id)=(…) is still referenced from table "projects".` |
| `23514`  | `check`       | `Failing row contains (…).` No columns.                                                                |

Recent Drizzle versions wrap the driver's error in a `DrizzleQueryError` and put the original error in `cause`. The
adapter checks the error and its `cause` chain for a `code`.

The table's own metadata gives columns more reliably than `detail` does. `getTableConfig(table)` lists its unique
constraints, indexes, foreign keys and checks by name, each with its columns:

1. **`constraint`:** the driver's `constraint` name, always.
2. **`columns` for a unique failure:** look the name up in the table's unique constraints and unique indexes.
   Otherwise parse `detail`'s `Key (…)` list.
3. **`columns` for a foreign-key failure on this table:** the error's `table` is this table's name. Look the name up
   in `getTableConfig(table).foreignKeys`; each has `getName()` and `reference().columns`.
4. **A delete restricted by another table:** the error's `table` is the referencing table. Report the constraint name
   only: `detail` names this table's referenced columns (`Key (id)`), not the foreign key's own columns.
5. **`columns` for a check failure:** from the check's name, if it is declared on the table. Otherwise the name only.
6. **Mapping column names:** convert database column names to the table's keys through `getTableColumns(table)`,
   since each column's `.name` is its database name.

## What changed in the contract

Working through Drizzle surfaced one ambiguity: **which columns a restricted delete reports**. Postgres's `detail`
for a delete blocked by a foreign key names the *referenced* columns (`Key (id)=…`), while the foreign key's own
columns live on the other table. The contract now says:

> `columns` are this table's columns that the constraint covers. A delete restricted by another table's foreign key
> reports that constraint's name and no columns.

The contract test for a restricted delete requires the constraint name. The memory adapter's `referencedBy` now
requires a `name` and reports no columns. A changeset declares a delete's foreign key by name:

```ts
Changeset.of(user).foreignKeyConstraint('id', 'projects_owner_id_fkey', { message: 'still owns projects' })
```

Nothing else needed to change:

- `where` is already opaque to the core;
- `narrow` lets the adapter build its own combinator;
- `violation` is synchronous and takes the thrown error;
- the adapter is built per call, so a transaction handle flows through the repo's context.

## Transactions and failed statements

In Postgres, a failed statement aborts the transaction it runs in. When a unique violation inside
`db.transaction(...)` becomes a field error, the repo returns `{ ok: false }`, but every later statement in that
transaction fails until it ends. The usual pattern is to `unwrap` the result inside the transaction, so the error
rolls it back. Prisma interactive transactions behave the same way.

A Drizzle adapter could also run each write in a nested `tx.transaction(...)`, which Drizzle runs as a savepoint, so
the outer transaction survives the failure. That would be an adapter option. The contract doesn't need it.

## Testing it

Run the contract against a Postgres `items` table:

```ts
adapterContract('drizzle', {
  adapter: () => drizzleAdapter(db, items),
  reset: () => db.delete(items),
  where: (values) => and(...Object.entries(values).map(([key, value]) => eq(getTableColumns(items)[key]!, value))),
  constraints: { unique: 'items_sku_key', foreignKey: 'items_parent_id_fkey', check: 'items_qty_check' }
}, { describe, it, beforeEach });
```

The table needs:

- a generated string `id`;
- a unique `sku`;
- `name`;
- `qty`, defaulting to 0, with a check that it is at least 0;
- `parentId`, a self-referencing foreign key with `onDelete: 'restrict'`.
