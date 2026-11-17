import { type Changeset, type ConstraintViolation, errorMessages, type Field } from './changeset.js';

// A repo runs changesets against one table through an adapter. It knows nothing about any ORM, and
// nothing about tenancy or auth: the adapter does the I/O, and the options say how to find a row, which
// columns the context sets, which columns no changeset may touch, and who may write. `Ctx` is whatever the
// caller passes through: a client or transaction handle, a session. The repo never opens a transaction;
// writes that must land together run on a transaction handle the caller puts in `Ctx`.

/**
 * The I/O a repo needs, for one table. Each ORM gets an adapter that implements it; the adapter contract
 * tests in `changeset/testing` check one.
 *
 * Every row an adapter returns is a fresh object: changing it must not change what a later read returns,
 * and a later write must not change it. A changeset keeps the row it was built over as `data`.
 */
export interface Adapter<Row, Where> {
  /** The one row `where` matches, or null. */
  findOne(where: Where): Promise<Row | null>;
  /** Inserts a row and returns it as stored. Throws the driver's error on a constraint failure. */
  insert(data: Partial<Row>): Promise<Row>;
  /** Writes `data` to the one row `where` matches and returns it as stored; null when nothing matched. */
  update(where: Where, data: Partial<Row>): Promise<Row | null>;
  /** Deletes the one row `where` matches and returns it as it was; null when nothing matched. */
  remove(where: Where): Promise<Row | null>;
  /** `where`, further limited to rows whose columns equal `values`. Used to detect stale writes. */
  narrow(where: Where, values: Partial<Row>): Where;
  /**
   * The driver's constraint failure, normalized; null for any other error. `columns`, when present, are
   * the row's keys, not database column names.
   */
  violation(error: unknown): ConstraintViolation | null;
}

export type Action = 'insert' | 'update' | 'delete';

/** Thrown when the row to write doesn't exist, or `find` excludes it. */
export class NotFoundError extends Error {
  constructor(message = 'Row not found') {
    super(message);
    this.name = 'NotFoundError';
  }
}

/** Thrown by `unwrap` for an invalid changeset; carries it. */
export class ChangesetError<T extends object = object> extends Error {
  constructor(readonly changeset: Changeset<T>) {
    super(errorMessages(changeset).join('; ') || 'Invalid changeset');
    this.name = 'ChangesetError';
  }
}

/** Thrown when a changeset changes a protected column: a programming error, not invalid input. */
export class ProtectedColumnError extends Error {
  constructor(readonly columns: readonly string[]) {
    super(`A changeset may not change ${columns.join(', ')}`);
    this.name = 'ProtectedColumnError';
  }
}

/** A written row with the changeset that wrote it, or the changeset that failed. */
export type WriteResult<Row extends object> =
  | { ok: true; row: Row; changeset: Changeset<Row> }
  | { ok: false; changeset: Changeset<Row> };

/** A result's row, or the error `toError` makes from the failed changeset (a `ChangesetError` by default). */
export function unwrap<Row extends object>(
  result: WriteResult<Row>,
  toError: (changeset: Changeset<Row>) => Error = (changeset) => new ChangesetError(changeset)
): Row {
  if (result.ok) return result.row;
  throw toError(result.changeset);
}

export interface RepoOptions<Row extends object, Where, Key, Ctx> {
  /** The adapter for one call. Built per call so it can use the context's transaction handle. */
  adapter(context: Ctx): Adapter<Row, Where>;
  /** The `where` that finds one row by key, including anything every write must match (a tenant, an owner). */
  find(key: Key, context: Ctx): Where;
  /** Throws to refuse the write. Runs before anything else. */
  authorize?(action: Action, context: Ctx): void;
  /** Columns set from the context, never from a changeset (a tenant, an actor). Laid over the changes, so they win. */
  stamp?: { insert?(context: Ctx): Partial<Row>; update?(context: Ctx): Partial<Row> };
  /** Columns no changeset may change, by any path. A change to one throws a `ProtectedColumnError`. */
  protect?: readonly Field<Row>[];
  /**
   * Columns whose stored values an update or delete must still match, such as an updated-at time. Their
   * values as read join the write's `where`; when the row has changed since, the write misses and the
   * result is a `base` error with code `stale`, not a not-found error.
   */
  lock?: readonly Field<Row>[];
  /**
   * Runs after each successful insert, update or delete, on the same context, before the result returns:
   * for an audit entry built from `changeset.diff()`. Pass a transaction handle in the context to make the
   * two land together. An update with no changes doesn't write, so doesn't run it.
   */
  afterWrite?(row: Row, changeset: Changeset<Row>, context: Ctx, action: Action): void | Promise<void>;
  /** What a missing row throws; a `NotFoundError` by default. */
  notFound?(key: Key, context: Ctx): Error;
}

export interface Repo<Row extends object, Key, Ctx> {
  /** Builds a changeset for a new row and inserts it. */
  insert(build: (context: Ctx) => Changeset<Row>, context: Ctx): Promise<WriteResult<Row>>;
  /**
   * Finds the row by key, builds a changeset over it, and writes it with the same `where`. A valid
   * changeset with no changes doesn't write, and returns the stored row.
   */
  update(key: Key, build: (row: Row, context: Ctx) => Changeset<Row>, context: Ctx): Promise<WriteResult<Row>>;
  /**
   * Finds the row by key, builds a changeset over it that carries the delete's checks, and deletes it.
   * The changeset may not change anything. On success, `row` is the row as it was.
   */
  delete(key: Key, build: (row: Row, context: Ctx) => Changeset<Row>, context: Ctx): Promise<WriteResult<Row>>;
}

/** The error a write whose locked columns changed since the read gets. */
export const STALE_MESSAGE = 'was changed by someone else';

/** A repo for one table. */
export function repo<Row extends object, Where, Key, Ctx>(options: RepoOptions<Row, Where, Key, Ctx>): Repo<Row, Key, Ctx> {
  const notFound = (key: Key, context: Ctx) => options.notFound?.(key, context) ?? new NotFoundError();

  const checkProtected = (changeset: Changeset<Row>) => {
    const touched = (options.protect ?? []).filter((column) => Object.hasOwn(changeset.changes, column));
    if (touched.length > 0) throw new ProtectedColumnError(touched);
  };

  const expect = (changeset: Changeset<Row>, action: 'insert' | 'update') => {
    if (changeset.action !== action) throw new Error(`Expected a changeset for ${action}, got one for ${changeset.action}`);
    return changeset;
  };

  /** The row's locked columns, as read. */
  const locked = (row: Row): Partial<Row> | null => {
    if (!options.lock?.length) return null;
    return Object.fromEntries(options.lock.map((column) => [column, row[column]])) as Partial<Row>;
  };

  /** A found row and the `where` that writes it, with locked values joined in. */
  async function load(key: Key, context: Ctx, adapter: Adapter<Row, Where>) {
    const where = options.find(key, context);
    const row = await adapter.findOne(where);
    if (!row) throw notFound(key, context);
    const values = locked(row);
    return { row, where, writeWhere: values ? adapter.narrow(where, values) : where };
  }

  /**
   * Validation, protection, prepare steps, then `run`; a declared constraint failure becomes a field error.
   * `missed` handles a write that matched no row.
   */
  async function write(
    initial: Changeset<Row>,
    action: Action,
    adapter: Adapter<Row, Where>,
    run: (changes: Partial<Row>) => Promise<Row | null>,
    context: Ctx,
    missed: (changeset: Changeset<Row>) => Promise<WriteResult<Row>>
  ): Promise<WriteResult<Row>> {
    let changeset = initial;
    if (!changeset.valid) return { ok: false, changeset };
    checkProtected(changeset);

    for (const prepare of changeset.prepares) {
      changeset = await (prepare as (c: Changeset<Row>, ctx: Ctx) => Changeset<Row> | Promise<Changeset<Row>>)(changeset, context);
    }
    if (!changeset.valid) return { ok: false, changeset };
    checkProtected(changeset);
    if (action === 'delete' && changeset.changed) throw new Error('A delete changeset may not change columns');

    let row: Row | null;
    try {
      row = await run({ ...changeset.changes });
    } catch (error) {
      const violation = adapter.violation(error);
      const failed = violation && changeset.withViolation(violation);
      if (failed) return { ok: false, changeset: failed };
      throw error;
    }
    if (!row) return missed(changeset);
    await options.afterWrite?.(row, changeset, context, action);
    return { ok: true, row, changeset };
  }

  /** A write that matched nothing: stale when the row is still there without the locked values, else missing. */
  const missedFor = (key: Key, where: Where, adapter: Adapter<Row, Where>, context: Ctx) => async (changeset: Changeset<Row>) => {
    if (options.lock?.length && (await adapter.findOne(where))) {
      return { ok: false as const, changeset: changeset.addError('base', STALE_MESSAGE, 'stale') };
    }
    throw notFound(key, context);
  };

  return {
    async insert(build, context) {
      options.authorize?.('insert', context);
      const adapter = options.adapter(context);
      const changeset = expect(build(context), 'insert');
      return write(
        changeset,
        'insert',
        adapter,
        (changes) => adapter.insert({ ...changes, ...options.stamp?.insert?.(context) }),
        context,
        async () => {
          throw new Error('Insert returned no row');
        }
      );
    },

    async update(key, build, context) {
      options.authorize?.('update', context);
      const adapter = options.adapter(context);
      const { row, where, writeWhere } = await load(key, context, adapter);
      const changeset = expect(build(row, context), 'update');
      if (changeset.valid && !changeset.changed) return { ok: true, row, changeset };
      return write(
        changeset,
        'update',
        adapter,
        (changes) => adapter.update(writeWhere, { ...changes, ...options.stamp?.update?.(context) }),
        context,
        missedFor(key, where, adapter, context)
      );
    },

    async delete(key, build, context) {
      options.authorize?.('delete', context);
      const adapter = options.adapter(context);
      const { row, where, writeWhere } = await load(key, context, adapter);
      const changeset = expect(build(row, context), 'update');
      return write(changeset, 'delete', adapter, () => adapter.remove(writeWhere), context, missedFor(key, where, adapter, context));
    }
  };
}
