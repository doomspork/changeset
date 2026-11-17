import type { StandardSchemaV1 } from './standard-schema.js';

// A changeset is a proposed write to one row: the row as stored (`data`, null for an insert), the columns
// the write would change (`changes`), and what is wrong with it (`errors`). Untrusted input enters through
// `cast`, which reads only permitted columns and parses each with its field schema; trusted values enter
// through `change` and `putChange`. Validators add errors and never throw, so a caller gets every problem
// at once. Nothing here touches a database: a repo runs a valid changeset through an adapter.
//
// Changesets are immutable. Every method returns a new changeset and leaves the receiver as it was.

/** A column name of `T`. */
export type Field<T> = keyof T & string;

/**
 * One schema per castable column, typed from the row so a renamed or retyped column breaks the build.
 * `K` limits which columns may have a schema at all: an app can exclude identity, tenant and ownership
 * columns there, so a schema for one is a compile error.
 */
export type Fields<T, K extends Field<T> = Field<T>> = { [P in K]?: StandardSchemaV1<unknown, T[P]> };

/** Where an error sits: a column, a path inside a JSON column (`address.city`), or `base` for the row. */
export type ErrorKey<T> = Field<T> | 'base' | `${Field<T>}.${string}`;

export interface FieldError {
  message: string;
  /**
   * Machine-readable: `required`, `invalid`, `inclusion`, `exclusion`, `format`, `length`, `number`,
   * `transition`, `unique`, `foreign_key`, `check`, or a custom validator's own.
   */
  code: string;
}

/** Errors by key. A key is present only when it has at least one error. */
export type Errors<T> = { readonly [K in ErrorKey<T>]?: readonly FieldError[] };

export type ConstraintKind = 'unique' | 'foreign_key' | 'check';

/** A database constraint failure, normalized by an adapter from its driver's error. */
export interface ConstraintViolation {
  kind: ConstraintKind;
  /** The constraint or index name, when the driver reports it. */
  constraint?: string;
  /** The columns, when the driver reports them. */
  columns?: readonly string[];
}

/** A declared constraint: which database failure maps to which field error. */
export interface ConstraintDeclaration {
  kind: ConstraintKind;
  /** A constraint name, or the exact set of columns it covers. */
  match: string | readonly string[];
  field: string;
  message: string;
}

/**
 * A step that runs inside the write, after validation, with the caller's context: an async lookup, a
 * value derived from another row. It returns the changeset, with changes or errors added.
 */
export type Prepare<T extends object, Ctx = unknown> = (
  changeset: Changeset<T>,
  context: Ctx
) => Changeset<T> | Promise<Changeset<T>>;

interface MessageOption {
  message?: string;
}

/** A map of allowed moves: `{ draft: ['active'], active: ['archived'] }`. */
export type Transitions<V> = { readonly [S in V & PropertyKey]?: readonly V[] };

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/**
 * Whether two column values are the same for the purpose of "is this a change". Dates compare by time,
 * arrays and plain objects (JSON columns) structurally, byte arrays by content, and other objects with a
 * primitive `valueOf` (decimals, for one) by that value.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => sameValue(item, b[i]));
  }
  if (isPlainObject(a) || isPlainObject(b)) {
    if (!isPlainObject(a) || !isPlainObject(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && sameValue(a[key], b[key]));
  }
  if (ArrayBuffer.isView(a) && ArrayBuffer.isView(b)) {
    const left = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const right = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    return left.length === right.length && left.every((byte, i) => byte === right[i]);
  }
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  const left = a.valueOf();
  const right = b.valueOf();
  return left !== a && right !== b && (typeof left !== 'object' || left === null) && Object.is(left, right);
}

function parse<V>(schema: StandardSchemaV1<unknown, V>, value: unknown): StandardSchemaV1.Result<V> {
  const result = schema['~standard'].validate(value);
  if (result instanceof Promise) {
    throw new TypeError('cast takes synchronous schemas; run asynchronous checks in a prepare step');
  }
  return result;
}

const isBlank = (value: unknown) => typeof value === 'string' && value.trim() === '';

/** The object type inside a JSON column's type, without null. */
export type Embedded<V> = Extract<NonNullable<V>, object> extends infer E ? (E extends readonly unknown[] ? never : E) : never;

/** `base` extended by an issue's path inside the value: `address.lines.0`. */
const issueKey = (base: string, issue: StandardSchemaV1.Issue | undefined) => {
  const path = (issue?.path ?? []).map((segment) => String(typeof segment === 'object' ? segment.key : segment));
  return [base, ...path].join('.');
};

export class Changeset<T extends object> {
  private constructor(
    /** The row as stored; null for an insert. */
    readonly data: Readonly<T> | null,
    /** The columns this write changes, and their new values. */
    readonly changes: Readonly<Partial<T>>,
    /** Every problem found so far, by key. */
    readonly errors: Errors<T>,
    /** The untrusted attributes given to `cast`, kept for validators that read them. */
    readonly params: Readonly<Record<string, unknown>>,
    /** Database constraints this changeset maps to field errors. Read by a repo. */
    readonly constraints: readonly ConstraintDeclaration[],
    /** Steps a repo runs inside the write. Read by a repo. */
    readonly prepares: readonly Prepare<T, never>[]
  ) {}

  /** An empty changeset over `data`: pass the stored row for an update, or null for an insert. */
  static of<T extends object>(data: T | null): Changeset<T> {
    return new Changeset<T>(data, {} as Partial<T>, {}, {}, [], []);
  }

  private with(next: {
    changes?: Partial<T>;
    errors?: Errors<T>;
    params?: Record<string, unknown>;
    constraints?: readonly ConstraintDeclaration[];
    prepares?: readonly Prepare<T, never>[];
  }): Changeset<T> {
    return new Changeset<T>(
      this.data,
      next.changes ?? this.changes,
      next.errors ?? this.errors,
      next.params ?? this.params,
      next.constraints ?? this.constraints,
      next.prepares ?? this.prepares
    );
  }

  /** `insert` when there is no stored row, else `update`. */
  get action(): 'insert' | 'update' {
    return this.data === null ? 'insert' : 'update';
  }

  /** True when there are no errors. */
  get valid(): boolean {
    return Object.keys(this.errors).length === 0;
  }

  /** True when the changeset changes at least one column. */
  get changed(): boolean {
    return Object.keys(this.changes).length > 0;
  }

  /** The value the column will have: the change if there is one, else the stored value. */
  getField<K extends Field<T>>(key: K): T[K] | undefined {
    return Object.hasOwn(this.changes, key) ? (this.changes as T)[key] : this.data?.[key];
  }

  /** The change to a column, or undefined when it doesn't change. */
  getChange<K extends Field<T>>(key: K): T[K] | undefined {
    return (this.changes as Partial<T>)[key];
  }

  /** What changes, as `{ column: { from, to } }`: the payload for an audit entry. */
  diff(): { [K in Field<T>]?: { from: T[K] | undefined; to: T[K] } } {
    return Object.fromEntries(
      Object.entries(this.changes).map(([key, to]) => [key, { from: this.data?.[key as Field<T>], to }])
    ) as { [K in Field<T>]?: { from: T[K] | undefined; to: T[K] } };
  }

  /** Adds an error under `key`. Never throws. */
  addError(key: ErrorKey<T>, message: string, code = 'invalid'): Changeset<T> {
    const current = this.errors[key] ?? [];
    return this.with({ errors: { ...this.errors, [key]: [...current, { message, code }] } });
  }

  /**
   * Untrusted attributes, read through field schemas. Only `permitted` keys are read and only when
   * present; every other key is ignored. Blank text becomes null before parsing, so a cleared form field
   * clears its column, and blank into a column whose schema rejects null is "can't be blank". A value equal
   * to the stored one is not a change. A key whose value is `undefined` counts as omitted.
   */
  cast<F extends Fields<T>>(attrs: unknown, fields: F, permitted: readonly (keyof F & Field<T>)[]): Changeset<T> {
    if (typeof attrs !== 'object' || attrs === null || Array.isArray(attrs)) {
      return this.addError('base', 'expected an object of attributes', 'invalid');
    }
    const input = attrs as Record<string, unknown>;
    let changeset = this.with({ params: { ...this.params, ...input } });
    for (const key of permitted) {
      if (!Object.hasOwn(input, key) || input[key] === undefined) continue;
      const schema = fields[key] as StandardSchemaV1<unknown, T[typeof key]> | undefined;
      if (!schema) throw new Error(`No field schema for permitted key "${key}"`);
      const value = isBlank(input[key]) ? null : input[key];
      const result = parse(schema, value);
      if (!result.issues) changeset = changeset.putChange(key, result.value);
      else if (value === null) changeset = changeset.addError(key, "can't be blank", 'required');
      else changeset = changeset.addError(key, result.issues[0]?.message ?? 'is invalid', 'invalid');
    }
    return changeset;
  }

  /**
   * A JSON column (an address, settings) from the attributes given to `cast`: `attrs[key]` is read as an
   * object, by the same rules as `cast`, with one schema per subkey. Only the permitted subkeys present
   * change; the others keep their stored values. An error on a subkey is reported as `key.subkey`. A value
   * for `key` that isn't an object is an error on `key`. Without a value for `key`, nothing changes.
   */
  castEmbed<K extends Field<T>, F extends Fields<Embedded<T[K]>>>(
    key: K,
    fields: F,
    permitted: readonly (keyof F & string)[]
  ): Changeset<T> {
    if (!Object.hasOwn(this.params, key) || this.params[key] === undefined) return this;
    const input = this.params[key];
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return this.addError(key, 'is invalid', 'invalid');
    }
    const stored = this.getField(key);
    const next: Record<string, unknown> = isPlainObject(stored) ? { ...stored } : {};
    let changeset: Changeset<T> = this;
    for (const subkey of permitted) {
      const raw = (input as Record<string, unknown>)[subkey];
      if (!Object.hasOwn(input, subkey) || raw === undefined) continue;
      const schema = (fields as Record<string, StandardSchemaV1 | undefined>)[subkey];
      if (!schema) throw new Error(`No field schema for permitted key "${key}.${subkey}"`);
      const value = isBlank(raw) ? null : raw;
      const result = parse(schema, value);
      const errorKey = `${key}.${subkey}` as ErrorKey<T>;
      if (!result.issues) next[subkey] = result.value;
      else if (value === null) changeset = changeset.addError(errorKey, "can't be blank", 'required');
      else changeset = changeset.addError(issueKey(errorKey, result.issues[0]) as ErrorKey<T>, result.issues[0]?.message ?? 'is invalid', 'invalid');
    }
    const failed = Object.keys(changeset.errors).some((errorKey) => errorKey.startsWith(`${key}.`));
    return failed ? changeset : changeset.putChange(key, next as T[K]);
  }

  /**
   * A check on the changeset as a whole, changed or not: for a rule across columns, or a delete's
   * restriction. Return a message for an error on `key`, or null when the changeset is fine.
   */
  check(key: ErrorKey<T>, check: (changeset: Changeset<T>) => string | null | undefined, code = 'invalid'): Changeset<T> {
    const message = check(this);
    return message ? this.addError(key, message, code) : this;
  }

  /** Trusted values for several columns at once. Values equal to the stored ones are not changes. */
  change(changes: { [K in Field<T>]?: T[K] }): Changeset<T> {
    return Object.entries(changes).reduce<Changeset<T>>(
      (changeset, [key, value]) => changeset.putChange(key as Field<T>, value as T[Field<T>]),
      this
    );
  }

  /** A trusted value: no parsing. A value equal to the stored one is not a change, and drops an earlier one. */
  putChange<K extends Field<T>>(key: K, value: T[K]): Changeset<T> {
    const { [key]: _previous, ...rest } = this.changes as Partial<T>;
    if (this.data !== null && sameValue(this.data[key], value)) return this.with({ changes: rest as Partial<T> });
    return this.with({ changes: { ...rest, [key]: value } as unknown as Partial<T> });
  }

  /** Rewrites a change if there is one, such as normalizing case. A column that doesn't change is left alone. */
  updateChange<K extends Field<T>>(key: K, update: (value: T[K]) => T[K]): Changeset<T> {
    return Object.hasOwn(this.changes, key) ? this.putChange(key, update((this.changes as T)[key])) : this;
  }

  /** Drops a change, leaving the stored value. */
  deleteChange(key: Field<T>): Changeset<T> {
    if (!Object.hasOwn(this.changes, key)) return this;
    const { [key]: _dropped, ...rest } = this.changes as Partial<T>;
    return this.with({ changes: rest as Partial<T> });
  }

  /**
   * Each column must end up non-null and, for text, non-blank, whether it changed or not. A column that
   * already has an error is skipped.
   */
  validateRequired(keys: readonly Field<T>[], { message = "can't be blank" }: MessageOption = {}): Changeset<T> {
    return keys.reduce<Changeset<T>>((changeset, key) => {
      if (changeset.errors[key]) return changeset;
      const value = changeset.getField(key);
      const missing = value === null || value === undefined || isBlank(value);
      return missing ? changeset.addError(key, message, 'required') : changeset;
    }, this);
  }

  /**
   * A custom check on one change. It runs only when the column changes and has no error yet; return a
   * message for an error, or null when the value is fine.
   */
  validateChange<K extends Field<T>>(
    key: K,
    validate: (value: T[K], changeset: Changeset<T>) => string | null | undefined,
    code = 'invalid'
  ): Changeset<T> {
    if (!Object.hasOwn(this.changes, key) || this.errors[key]) return this;
    const message = validate((this.changes as T)[key], this);
    return message ? this.addError(key, message, code) : this;
  }

  /** The change must be one of `values`. */
  validateInclusion<K extends Field<T>>(
    key: K,
    values: readonly T[K][],
    { message = 'is invalid' }: MessageOption = {}
  ): Changeset<T> {
    return this.validateChange(key, (value) => (values.some((v) => sameValue(v, value)) ? null : message), 'inclusion');
  }

  /** The change must not be one of `values`. */
  validateExclusion<K extends Field<T>>(
    key: K,
    values: readonly T[K][],
    { message = 'is reserved' }: MessageOption = {}
  ): Changeset<T> {
    return this.validateChange(key, (value) => (values.some((v) => sameValue(v, value)) ? message : null), 'exclusion');
  }

  /** A text change must match `pattern`. Null is left to `validateRequired`. */
  validateFormat<K extends Field<T>>(key: K, pattern: RegExp, { message = 'has invalid format' }: MessageOption = {}): Changeset<T> {
    return this.validateChange(
      key,
      (value) => {
        if (value === null || value === undefined) return null;
        pattern.lastIndex = 0;
        return typeof value === 'string' && pattern.test(value) ? null : message;
      },
      'format'
    );
  }

  /**
   * A text or array change must have a length in range; text counts characters, not UTF-16 units. Null is
   * left to `validateRequired`.
   */
  validateLength<K extends Field<T>>(
    key: K,
    { min, max, is, message }: { min?: number; max?: number; is?: number } & MessageOption
  ): Changeset<T> {
    return this.validateChange(
      key,
      (value) => {
        if (value === null || value === undefined) return null;
        const length = typeof value === 'string' ? Array.from(value).length : Array.isArray(value) ? value.length : NaN;
        if (Number.isNaN(length)) return message ?? 'has no length';
        if (is !== undefined && length !== is) return message ?? `should be ${is} long`;
        if (min !== undefined && length < min) return message ?? `should be at least ${min} long`;
        if (max !== undefined && length > max) return message ?? `should be at most ${max} long`;
        return null;
      },
      'length'
    );
  }

  /** A numeric change must be in range. Null is left to `validateRequired`. */
  validateNumber<K extends Field<T>>(
    key: K,
    { gt, gte, lt, lte, message }: { gt?: number; gte?: number; lt?: number; lte?: number } & MessageOption
  ): Changeset<T> {
    return this.validateChange(
      key,
      (value) => {
        if (value === null || value === undefined) return null;
        const n = typeof value === 'number' || typeof value === 'bigint' ? value : Number(value);
        if (typeof n === 'number' && Number.isNaN(n)) return message ?? 'is not a number';
        if (gt !== undefined && !(n > gt)) return message ?? `should be greater than ${gt}`;
        if (gte !== undefined && !(n >= gte)) return message ?? `should be at least ${gte}`;
        if (lt !== undefined && !(n < lt)) return message ?? `should be less than ${lt}`;
        if (lte !== undefined && !(n <= lte)) return message ?? `should be at most ${lte}`;
        return null;
      },
      'number'
    );
  }

  /**
   * A state machine on one column: `allowed[from]` lists the states a row may move to from `from`. On an
   * update, a change the stored state can't reach is an error. On an insert, the row may start in any
   * state `allowed` has a key for. A state `allowed` doesn't know is a compile error.
   */
  validateTransition<K extends Field<T>, const A extends Transitions<T[K]>>(
    key: K,
    allowed: A & { readonly [S in Exclude<keyof A, T[K] & PropertyKey>]: never },
    { message }: MessageOption = {}
  ): Changeset<T> {
    const moves = allowed as Transitions<T[K]>;
    return this.validateChange(
      key,
      (to) => {
        if (this.data === null) {
          return Object.hasOwn(moves, to as PropertyKey) ? null : (message ?? `can't start as ${String(to)}`);
        }
        const from = this.data[key] as T[K] & PropertyKey;
        const reachable = (Object.hasOwn(moves, from) ? moves[from] : undefined) ?? [];
        return reachable.includes(to) ? null : (message ?? `can't change from ${String(from)} to ${String(to)}`);
      },
      'transition'
    );
  }

  /** A unique violation on `match` (a constraint name, or the exact set of columns) becomes an error on `field`. */
  uniqueConstraint(field: Field<T>, match: string | readonly Field<T>[] = [field], { message = 'has already been taken' }: MessageOption = {}) {
    return this.declare({ kind: 'unique', match, field, message });
  }

  /**
   * A foreign-key violation on `match` (a constraint name, or the referencing columns) becomes an error on
   * `field`. On an insert or update that means the referenced row doesn't exist; on a delete, that rows
   * still reference this one.
   */
  foreignKeyConstraint(field: Field<T>, match: string | readonly Field<T>[] = [field], { message = 'does not exist' }: MessageOption = {}) {
    return this.declare({ kind: 'foreign_key', match, field, message });
  }

  /** A check-constraint violation on the named constraint becomes an error on `field`. */
  checkConstraint(field: Field<T>, constraint: string, { message = 'is invalid' }: MessageOption = {}) {
    return this.declare({ kind: 'check', match: constraint, field, message });
  }

  private declare(constraint: ConstraintDeclaration): Changeset<T> {
    return this.with({ constraints: [...this.constraints, constraint] });
  }

  /**
   * A step the repo runs inside the write, after validation, with its context: for a check or a value
   * that needs a lookup. Steps run in the order declared; a step declared from inside another step is
   * not run. `Ctx` is the repo's context type; the changeset doesn't check it.
   */
  prepare<Ctx>(prepare: Prepare<T, Ctx>): Changeset<T> {
    return this.with({ prepares: [...this.prepares, prepare as Prepare<T, never>] });
  }

  /**
   * The changeset with the error a declared constraint maps `violation` to, or null when no declaration
   * matches. A declaration by name matches the reported constraint name; one by columns matches when the
   * reported columns are exactly the declared ones, in any order.
   */
  withViolation(violation: ConstraintViolation): Changeset<T> | null {
    const declared = this.constraints.find((candidate) => {
      if (candidate.kind !== violation.kind) return false;
      if (typeof candidate.match === 'string') return candidate.match === violation.constraint;
      const columns = violation.columns;
      return (
        columns !== undefined &&
        columns.length === candidate.match.length &&
        candidate.match.every((column) => columns.includes(column))
      );
    });
    return declared ? this.addError(declared.field as Field<T>, declared.message, violation.kind) : null;
  }
}

/**
 * Untrusted attributes to a changeset over `data` (the stored row, or null for an insert). See
 * `Changeset#cast` for the rules. For an insert, `T` can't be inferred from null: write
 * `Changeset.of<Row>(null).cast(...)`, or pass both type arguments.
 */
export function cast<T extends object, F extends Fields<T>>(
  data: T | null,
  attrs: unknown,
  fields: F,
  permitted: readonly (keyof F & Field<T>)[]
): Changeset<T> {
  return Changeset.of<T>(data).cast(attrs, fields, permitted);
}

/** Trusted changes to `data`, such as an archive stamping `archivedAt`. */
export function change<T extends object>(data: T | null, changes: { [K in Field<T>]?: T[K] }): Changeset<T> {
  return Changeset.of<T>(data).change(changes);
}

/** Flat messages, `column message` (or just the message for `base`), for a toast or a log. */
export function errorMessages<T extends object>(changeset: Changeset<T>): string[] {
  return Object.entries(changeset.errors).flatMap(([key, errors]) =>
    (errors as readonly FieldError[]).map(({ message }) => (key === 'base' ? message : `${key} ${message}`))
  );
}
