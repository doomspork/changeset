// Compile-time tests: `pnpm typecheck` fails if any `@ts-expect-error` here stops being an error.
import * as v from 'valibot';
import { z } from 'zod';
import { Changeset, cast, change, type Fields, repo } from '../../src/index.js';
import { fakeAdapter, fields, type Project, type ProjectFields, STATUS_FLOW, stored } from '../fixtures.js';

// A field schema whose output doesn't match the column type.
const mistyped = {
  // @ts-expect-error name is a string column, not a number
  name: z.number()
} satisfies Fields<Project>;

const mistypedValibot = {
  // @ts-expect-error priority is a number column
  priority: v.string()
} satisfies Fields<Project>;

// A nullable schema for a non-null column.
const nullable = {
  // @ts-expect-error name can't be null
  name: z.string().nullable()
} satisfies Fields<Project>;

// A schema for a column that doesn't exist.
const unknownColumn = {
  // @ts-expect-error no such column
  title: z.string()
} satisfies Fields<Project>;

// A narrowed `Fields` rejects a protected column.
const leak = {
  name: z.string(),
  // @ts-expect-error accountId is protected
  accountId: z.string()
} satisfies ProjectFields;

// A permitted key with no schema.
// @ts-expect-error ownerId has no schema in `fields`
cast(stored(), {}, fields, ['name', 'ownerId']);
// @ts-expect-error ownerId has no schema in `fields`
Changeset.of<Project>(null).cast({}, fields, ['ownerId']);

// A permitted key that isn't a column at all.
// @ts-expect-error nope is not a column
cast(stored(), {}, { name: z.string() }, ['nope']);

// An unknown transition state, as a from-state or a to-state, inline or in a variable.
change(stored(), {}).validateTransition('status', {
  draft: ['active'],
  // @ts-expect-error deleted is not a status
  deleted: ['draft']
});
// @ts-expect-error deleted is not a status
change(stored(), {}).validateTransition('status', { draft: ['deleted'] });
const flowWithUnknownFrom = { draft: ['active'], deleted: ['draft'] } as const;
// @ts-expect-error deleted is not a status
change(stored(), {}).validateTransition('status', flowWithUnknownFrom);
change(stored(), {}).validateTransition('status', STATUS_FLOW);

// Trusted values are typed by column.
// @ts-expect-error priority is a number
change(stored(), { priority: 'high' });
// @ts-expect-error status must be a Status
Changeset.of(stored()).putChange('status', 'deleted');
// @ts-expect-error no such column
Changeset.of(stored()).validateRequired(['title']);

// Constraint declarations take real columns.
// @ts-expect-error no such column
Changeset.of(stored()).uniqueConstraint('slug', ['accountId', 'slugg']);

// The repo's build must produce a changeset for its row type.
interface Other {
  id: string;
  label: string;
}
const projects = repo<Project, Partial<Project>, string, { rows: Project[] }>({
  adapter: (ctx) => fakeAdapter(ctx.rows),
  find: (id) => ({ id })
});
// @ts-expect-error a changeset for another row type
void projects.insert(() => Changeset.of<Other>(null), { rows: [] });
// @ts-expect-error protect takes real columns
repo<Project, Partial<Project>, string, unknown>({ adapter: () => fakeAdapter([]), find: (id) => ({ id }), protect: ['nope'] });

// What does compile: values are inferred from the row.
const name: string | undefined = cast(stored(), {}, fields, ['name']).getField('name');
const diff: { from: Project['status'] | undefined; to: Project['status'] } | undefined = Changeset.of(stored()).diff().status;

void [mistyped, mistypedValibot, nullable, unknownColumn, leak, name, diff];
