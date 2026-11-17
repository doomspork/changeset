import { z } from 'zod';
import type { Adapter, ConstraintViolation, Field, Fields } from '../src/index.js';

export type Status = 'draft' | 'active' | 'archived';

export interface Project {
  id: string;
  accountId: string;
  name: string;
  slug: string;
  description: string | null;
  status: Status;
  priority: number;
  tags: string[];
  dueAt: Date | null;
  settings: { theme: string; notify: boolean };
  ownerId: string;
}

export const PROTECTED = ['id', 'accountId', 'ownerId'] as const;
export type ProjectFields = Fields<Project, Exclude<Field<Project>, (typeof PROTECTED)[number]>>;

export const fields = {
  name: z.string().trim().min(1).max(120),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9-]+$/, 'has invalid format'),
  description: z.string().nullable(),
  status: z.enum(['draft', 'active', 'archived']),
  priority: z.coerce.number().int(),
  tags: z.array(z.string()),
  dueAt: z.coerce.date().nullable(),
  settings: z.object({ theme: z.string(), notify: z.boolean() })
} satisfies ProjectFields;

export const STATUS_FLOW = { draft: ['active', 'archived'], active: ['archived'], archived: ['active'] } as const;

export const stored = (overrides: Partial<Project> = {}): Project => ({
  id: 'p1',
  accountId: 'a1',
  name: 'Apollo',
  slug: 'apollo',
  description: null,
  status: 'draft',
  priority: 1,
  tags: ['x'],
  dueAt: new Date('2026-01-01T00:00:00Z'),
  settings: { theme: 'dark', notify: true },
  ownerId: 'u1',
  ...overrides
});

/**
 * A minimal adapter over an array, for the core's own tests: `where` is a partial row matched by
 * equality, and inserts check `unique` column sets.
 */
export function fakeAdapter<Row extends { id: string }>(
  rows: Row[],
  { unique = [], fail }: { unique?: readonly (readonly (keyof Row & string)[])[]; fail?: () => unknown } = {}
): Adapter<Row, Partial<Row>> & { writes: number } {
  const matches = (row: Row, where: Partial<Row>) =>
    Object.entries(where).every(([key, value]) => row[key as keyof Row] === value);
  const conflict = (candidate: Row, self?: Row) =>
    unique.find((columns) => rows.some((row) => row !== self && columns.every((column) => row[column] === candidate[column])));
  const adapter = {
    writes: 0,
    findOne: async (where: Partial<Row>) => {
      const row = rows.find((candidate) => matches(candidate, where));
      return row ? { ...row } : null;
    },
    insert: async (data: Partial<Row>) => {
      adapter.writes++;
      if (fail) throw fail();
      const row = { id: `p${rows.length + 1}`, ...data } as Row;
      const columns = conflict(row);
      if (columns) throw Object.assign(new Error('unique'), { columns });
      rows.push(row);
      return { ...row };
    },
    update: async (where: Partial<Row>, data: Partial<Row>) => {
      adapter.writes++;
      if (fail) throw fail();
      const row = rows.find((candidate) => matches(candidate, where));
      if (!row) return null;
      const columns = conflict({ ...row, ...data }, row);
      if (columns) throw Object.assign(new Error('unique'), { columns });
      return { ...Object.assign(row, data) };
    },
    remove: async (where: Partial<Row>) => {
      adapter.writes++;
      const index = rows.findIndex((candidate) => matches(candidate, where));
      return index === -1 ? null : { ...rows.splice(index, 1)[0]! };
    },
    narrow: (where: Partial<Row>, values: Partial<Row>) => ({ ...where, ...values }),
    violation: (error: unknown): ConstraintViolation | null => {
      const { columns, violation } = error as { columns?: string[]; violation?: ConstraintViolation };
      return violation ?? (columns ? { kind: 'unique', columns } : null);
    }
  };
  return adapter;
}
