import type { ConstraintKind, ConstraintViolation } from '../changeset.js';
import type { Adapter } from '../repo.js';

// A Prisma model delegate (`prisma.project`, or the same on a transaction client) as a repo adapter. The
// types come from the delegate itself: every generated delegate carries its model's type map under a
// symbol key, which is where the row, `where`, create and update types are read from. Nothing here is
// imported from a Prisma package, so this works with any generated client, from either generator.

/** The slice of a model's generated type map this adapter reads. */
export interface PrismaModelTypes {
  payload: { scalars: object };
  operations: {
    findUnique: { args: { where: unknown } };
    create: { args: { data: unknown } };
    update: { args: { where: unknown; data: unknown } };
    delete: { args: { where: unknown } };
  };
}

type Operation = (args: never) => PromiseLike<unknown>;

/**
 * A Prisma model delegate, structurally. The methods are typed loosely because Prisma's are generic; the
 * row and input types are read from the type map instead.
 */
export interface PrismaDelegate<Types extends PrismaModelTypes = PrismaModelTypes> {
  readonly [key: symbol]: { types: Types };
  findUnique: Operation;
  create: Operation;
  update: Operation;
  delete: Operation;
}

type TypesOf<D> = D extends { readonly [key: symbol]: { types: infer Types extends PrismaModelTypes } } ? Types : never;

/** The model's row: its scalar columns, as `findUnique` returns them without `select` or `include`. */
export type PrismaRow<D> = TypesOf<D>['payload']['scalars'];
/** A unique `where` (`{ id }`, a compound key), which may add filters on other columns (`{ id, accountId }`). */
export type PrismaWhere<D> = TypesOf<D>['operations']['update']['args']['where'];
/** The `data` of `create`. */
export type PrismaCreate<D> = TypesOf<D>['operations']['create']['args']['data'];
/** The `data` of `update`. */
export type PrismaUpdate<D> = TypesOf<D>['operations']['update']['args']['data'];

/**
 * What the adapter knows about a model's table, used to report a violation's columns as field names. The
 * adapter reads it from the client's runtime model when it can; `prismaViolation` takes it directly.
 */
export interface PrismaModelInfo {
  /** The table name. */
  table: string;
  /** Field name by database column name, for every scalar field. */
  fields: Readonly<Record<string, string>>;
}

interface DriverAdapterCause {
  kind?: string;
  originalCode?: string;
  originalMessage?: string;
  message?: string;
  constraint?: { fields?: unknown; index?: unknown; foreignKey?: unknown };
}

interface PrismaErrorShape {
  name?: string;
  code?: string;
  message?: string;
  meta?: {
    target?: unknown;
    field_name?: unknown;
    constraint?: unknown;
    driverAdapterError?: { cause?: DriverAdapterCause };
  };
}

const SQLSTATE: Record<string, ConstraintKind> = { '23505': 'unique', '23503': 'foreign_key', '23514': 'check' };
const ADAPTER_KINDS: Record<string, ConstraintKind> = {
  UniqueConstraintViolation: 'unique',
  ForeignKeyConstraintViolation: 'foreign_key'
};
const ERROR_CODES: Record<string, ConstraintKind> = { P2002: 'unique', P2003: 'foreign_key' };
const SUFFIXES: Record<ConstraintKind, string> = { unique: '_key', foreign_key: '_fkey', check: '_check' };

const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string') ? value : undefined;
const string = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

/** The constraint name in a Postgres message: `violates check constraint "items_qty_check"`. */
const quotedConstraint = (message: string | undefined) =>
  message?.match(/violates (?:unique|foreign key|check) constraint \\?"([^"\\]+)\\?"/)?.[1];

/**
 * The columns a constraint name covers, when it follows the default naming (`<table>_<columns>_key`,
 * `_fkey`, `_check`) and splits into the table's columns exactly one way.
 */
function columnsFromName(name: string, kind: ConstraintKind, model: PrismaModelInfo): string[] | undefined {
  const prefix = `${model.table}_`;
  const suffix = SUFFIXES[kind];
  if (!name.startsWith(prefix) || !name.endsWith(suffix)) return undefined;
  const middle = name.slice(prefix.length, name.length - suffix.length);
  const columns = Object.keys(model.fields);
  const splits: string[][] = [];
  const walk = (rest: string, taken: string[]) => {
    if (splits.length > 1) return;
    for (const column of columns) {
      if (rest === column) splits.push([...taken, column]);
      else if (rest.startsWith(`${column}_`)) walk(rest.slice(column.length + 1), [...taken, column]);
    }
  };
  walk(middle, []);
  return splits.length === 1 ? splits[0] : undefined;
}

/**
 * Prisma's constraint errors, normalized. Handles both shapes Prisma reports:
 *
 * - The query engine's (Prisma 6, with or without a driver adapter): P2002 with `meta.target` as database
 *   columns or an index name, P2003 with `meta.constraint` or `meta.field_name`. A check violation has no
 *   error code; its constraint name is read from the message.
 * - The driver adapter's (Prisma 7): `meta.driverAdapterError.cause`, with `kind`, `originalCode` and
 *   `constraint.index` or `constraint.fields`. A check violation is P2039 with SQLSTATE 23514, its name read
 *   from `originalMessage`.
 *
 * With `model`, database column names become field names, and a constraint reported only by its default
 * name (`projects_account_id_slug_key`) also gets its columns.
 */
export function prismaViolation(error: unknown, model?: PrismaModelInfo): ConstraintViolation | null {
  if (typeof error !== 'object' || error === null) return null;
  const { code, name, message, meta } = error as PrismaErrorShape;
  const cause = meta?.driverAdapterError?.cause;

  const kind: ConstraintKind | undefined =
    (cause?.kind ? ADAPTER_KINDS[cause.kind] : undefined) ??
    (cause?.originalCode ? SQLSTATE[cause.originalCode] : undefined) ??
    (code ? ERROR_CODES[code] : undefined) ??
    (name === 'PrismaClientUnknownRequestError' && /code: "23514"/.test(message ?? '') ? 'check' : undefined);
  if (!kind) return null;

  // Older engines name a foreign key's column, or its constraint, in `field_name`.
  const fieldName = string(meta?.field_name)?.replace(/ \(index\)$/, '');
  const fieldIsColumn = fieldName !== undefined && (model ? fieldName in model.fields : !fieldName.endsWith('_fkey'));
  const constraint =
    string(cause?.constraint?.index) ??
    quotedConstraint(cause?.originalMessage ?? cause?.message) ??
    string(meta?.constraint) ??
    string(meta?.target) ??
    (kind === 'check' ? quotedConstraint(message) : undefined) ??
    (fieldName !== undefined && !fieldIsColumn ? fieldName : undefined);

  const reported = strings(cause?.constraint?.fields) ?? strings(meta?.target) ?? (fieldIsColumn ? [fieldName] : undefined);
  const columns = reported
    ? reported.map((column) => model?.fields[column] ?? column)
    : constraint && model
      ? columnsFromName(constraint, kind, model)?.map((column) => model.fields[column]!)
      : undefined;

  return { kind, ...(constraint !== undefined && { constraint }), ...(columns !== undefined && { columns }) };
}

interface RuntimeModel {
  dbName?: string | null;
  fields?: readonly { name: string; dbName?: string | null; kind?: string }[];
}

/**
 * The model's table and column names, read from the client's runtime model through the delegate's
 * `$parent` and `$name`. Undefined when the client doesn't expose them.
 */
export function prismaModelInfo(delegate: object): PrismaModelInfo | undefined {
  const { $name, $parent } = delegate as { $name?: unknown; $parent?: { _runtimeDataModel?: { models?: Record<string, RuntimeModel> } } };
  if (typeof $name !== 'string') return undefined;
  const model = $parent?._runtimeDataModel?.models?.[$name];
  if (!model?.fields) return undefined;
  const fields: Record<string, string> = {};
  for (const field of model.fields) {
    if (field.kind === undefined || field.kind === 'scalar' || field.kind === 'enum') fields[field.dbName ?? field.name] = field.name;
  }
  return { table: model.dbName ?? $name, fields };
}

const isNotFound = (error: unknown) => (error as { code?: unknown } | null)?.code === 'P2025';

export interface PrismaAdapterOptions {
  /** The model's table and columns, when the client doesn't expose them; see `prismaModelInfo`. */
  model?: PrismaModelInfo;
}

/**
 * A Prisma model as a repo adapter: `prismaAdapter(prisma.project)`, or `prismaAdapter(tx.project)` inside
 * a transaction. The row and `where` types are inferred from the delegate.
 *
 * `where` is a unique `where`, which Prisma lets carry filters on other columns (an id plus a tenant): a
 * row the extra filter excludes reads as missing, for reads and writes alike.
 */
export function prismaAdapter<D extends PrismaDelegate>(
  delegate: D,
  options: PrismaAdapterOptions = {}
): Adapter<PrismaRow<D>, PrismaWhere<D>> {
  type Row = PrismaRow<D>;
  type Where = PrismaWhere<D>;
  const call = (operation: Operation, args: object) => operation.call(delegate, args as never) as PromiseLike<Row>;
  let model: PrismaModelInfo | undefined | null = options.model ?? null;
  const info = () => (model === null ? (model = prismaModelInfo(delegate)) : model);
  const missingAsNull = async (run: () => PromiseLike<Row>): Promise<Row | null> => {
    try {
      return await run();
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  };

  return {
    findOne: async (where) => (await call(delegate.findUnique, { where })) ?? null,
    insert: async (data) => call(delegate.create, { data }),
    update: (where, data) => missingAsNull(() => call(delegate.update, { where, data })),
    remove: (where) => missingAsNull(() => call(delegate.delete, { where })),
    narrow: (where, values) => {
      const base = where as Record<string, unknown>;
      const and = base.AND === undefined ? [] : Array.isArray(base.AND) ? base.AND : [base.AND];
      return { ...base, AND: [...and, values] } as Where;
    },
    violation: (error) => prismaViolation(error, info())
  };
}
