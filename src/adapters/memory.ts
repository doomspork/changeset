import { type ConstraintViolation, type Field, sameValue } from '../changeset.js';
import type { Adapter } from '../repo.js';

// An in-memory table: for tests, and as the reference for what an adapter must do. A `where` is a partial
// row matched by equality. Constraints behave as they do in SQL: null never conflicts with a unique
// constraint and never fails a foreign key, and a failure leaves the table as it was.

interface Named {
  /** The constraint name to report. */
  name?: string;
}

export interface MemoryUnique<Row> extends Named {
  columns: readonly Field<Row>[];
}

/** This table's columns must match a row in another table (or this one), unless one of them is null. */
export interface MemoryForeignKey<Row> extends Named {
  columns: readonly Field<Row>[];
  /** The referenced rows, read at write time. */
  references: () => readonly object[];
  /** The referenced columns, in the same order; defaults to `['id']`. */
  referencedColumns?: readonly string[];
}

/**
 * Rows in another table (or this one) reference this table, so a referenced row can't be removed. The
 * violation reports the constraint's name only: its columns belong to the referencing table.
 */
export interface MemoryReferencedBy {
  /** The foreign key's constraint name. */
  name: string;
  /** The referencing rows, read at remove time. */
  rows: () => readonly object[];
  /** The referencing columns. */
  columns: readonly string[];
  /** This table's columns they point at, in the same order; defaults to `['id']`. */
  referencedColumns?: readonly string[];
}

export interface MemoryCheck<Row> extends Named {
  name: string;
  /** False fails the check. */
  test(row: Row): boolean;
  /** The columns to report. */
  columns?: readonly Field<Row>[];
}

export interface MemoryOptions<Row> {
  /** The table's rows. Shared with the caller, so a test can seed and inspect them. */
  rows?: Row[];
  /** Builds a whole row from inserted data: generated ids, column defaults. */
  defaults(data: Partial<Row>): Row;
  /** Runs on every update, for columns the database sets itself, such as an updated-at time. */
  onUpdate?(row: Row): Partial<Row>;
  unique?: readonly MemoryUnique<Row>[];
  foreignKeys?: readonly MemoryForeignKey<Row>[];
  referencedBy?: readonly MemoryReferencedBy[];
  checks?: readonly MemoryCheck<Row>[];
}

/** The error a memory table throws for a constraint failure. */
export class MemoryConstraintError extends Error {
  constructor(readonly violation: ConstraintViolation) {
    super(`${violation.kind} constraint ${violation.constraint ?? violation.columns?.join(', ')} failed`);
    this.name = 'MemoryConstraintError';
  }
}

export interface MemoryAdapter<Row> extends Adapter<Row, Partial<Row>> {
  readonly rows: Row[];
}

// A global in every runtime the package supports (Node 17+, browsers, Deno, Bun); declared here so the
// build needs neither DOM nor Node types.
declare function structuredClone<T>(value: T): T;

const NEVER = Symbol('matches nothing');
const read = (row: object, column: string) => (row as Record<string, unknown>)[column];
const violated = (kind: ConstraintViolation['kind'], named: Named, columns?: readonly string[]) =>
  new MemoryConstraintError({ kind, ...(named.name !== undefined && { constraint: named.name }), ...(columns && { columns }) });

/** An in-memory table as an adapter. */
export function memoryAdapter<Row extends object>(options: MemoryOptions<Row>): MemoryAdapter<Row> {
  const rows = options.rows ?? [];
  const copy = (row: Row): Row => structuredClone(row);
  const matches = (row: Row, where: Partial<Row>) =>
    Object.entries(where).every(([column, value]) => value === undefined || sameValue(read(row, column), value));
  const find = (where: Partial<Row>) => rows.findIndex((row) => matches(row, where));

  /** Throws for the first constraint `candidate` breaks; `self` is the row it replaces, if any. */
  const check = (candidate: Row, self?: Row) => {
    for (const unique of options.unique ?? []) {
      const values = unique.columns.map((column) => read(candidate, column));
      if (values.some((value) => value === null || value === undefined)) continue;
      const taken = rows.some((row) => row !== self && unique.columns.every((column, i) => sameValue(read(row, column), values[i])));
      if (taken) throw violated('unique', unique, unique.columns);
    }
    for (const key of options.foreignKeys ?? []) {
      const values = key.columns.map((column) => read(candidate, column));
      if (values.some((value) => value === null || value === undefined)) continue;
      const targets = key.referencedColumns ?? ['id'];
      const pool = key.references().map((row) => (row === self ? candidate : row));
      if (!pool.some((row) => targets.every((column, i) => sameValue(read(row, column), values[i])))) {
        throw violated('foreign_key', key, key.columns);
      }
    }
    for (const rule of options.checks ?? []) {
      if (!rule.test(candidate)) throw violated('check', rule, rule.columns);
    }
  };

  return {
    rows,
    findOne: async (where) => {
      const index = find(where);
      return index === -1 ? null : copy(rows[index]!);
    },
    insert: async (data) => {
      const row = options.defaults(structuredClone(data));
      check(row);
      rows.push(row);
      return copy(row);
    },
    update: async (where, data) => {
      const index = find(where);
      if (index === -1) return null;
      const current = rows[index]!;
      const changed = { ...current, ...structuredClone(data) };
      const next = { ...changed, ...options.onUpdate?.(changed) };
      check(next, current);
      rows[index] = next;
      return copy(next);
    },
    remove: async (where) => {
      const index = find(where);
      if (index === -1) return null;
      const current = rows[index]!;
      for (const reference of options.referencedBy ?? []) {
        const targets = reference.referencedColumns ?? ['id'];
        const referenced = reference
          .rows()
          .some((row) => row !== current && reference.columns.every((column, i) => sameValue(read(row, column), read(current, targets[i]!))));
        if (referenced) throw violated('foreign_key', reference);
      }
      rows.splice(index, 1);
      return copy(current);
    },
    narrow: (where, values) => {
      const conflict = Object.entries(values).some(
        ([column, value]) => Object.hasOwn(where, column) && !sameValue(read(where, column), value)
      );
      // A column can't equal two different values: match nothing.
      return conflict ? ({ ...where, [Object.keys(values)[0]!]: NEVER } as Partial<Row>) : { ...where, ...values };
    },
    violation: (error) => (error instanceof MemoryConstraintError ? error.violation : null)
  };
}
