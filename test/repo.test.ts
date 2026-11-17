import { describe, expect, it } from 'vitest';
import {
  type Changeset,
  ChangesetError,
  change,
  Changeset as CS,
  NotFoundError,
  ProtectedColumnError,
  repo,
  unwrap
} from '../src/index.js';
import { fakeAdapter, fields, type Project, PROTECTED, stored } from './fixtures.js';

interface Ctx {
  accountId: string;
  userId: string;
  canWrite?: boolean;
  rows: Project[];
  adapter: ReturnType<typeof fakeAdapter<Project>>;
}

const context = (rows: Project[] = [stored()], overrides: Partial<Ctx> = {}): Ctx => {
  const adapter = fakeAdapter(rows, { unique: [['accountId', 'slug']] });
  return { accountId: 'a1', userId: 'u1', rows, adapter, ...overrides };
};

class Forbidden extends Error {}
class Missing extends Error {}

const projects = repo<Project, Partial<Project>, string, Ctx>({
  adapter: (ctx) => ctx.adapter,
  find: (id, ctx) => ({ id, accountId: ctx.accountId }),
  authorize: (_action, ctx) => {
    if (ctx.canWrite === false) throw new Forbidden();
  },
  stamp: {
    insert: (ctx) => ({ accountId: ctx.accountId, ownerId: ctx.userId }),
    update: () => ({ description: 'stamped' })
  },
  protect: [...PROTECTED]
});

const create = (attrs: unknown) =>
  CS.of<Project>(null)
    .cast(attrs, fields, ['name', 'slug'])
    .change({ status: 'draft', priority: 1, tags: [], dueAt: null, settings: { theme: 'light', notify: false }, description: null })
    .validateRequired(['name', 'slug'])
    .uniqueConstraint('slug', ['accountId', 'slug']);

describe('repo.insert', () => {
  it('inserts a valid changeset with stamps laid over the changes', async () => {
    const ctx = context([]);
    const result = await projects.insert(() => create({ name: 'Zeus', slug: 'zeus' }), ctx);
    expect(result.ok).toBe(true);
    expect(unwrap(result)).toMatchObject({ name: 'Zeus', slug: 'zeus', accountId: 'a1', ownerId: 'u1' });
    expect(ctx.rows).toHaveLength(1);
  });

  it('returns an invalid changeset without writing', async () => {
    const ctx = context([]);
    const result = await projects.insert(() => create({ name: '' }), ctx);
    expect(result.ok).toBe(false);
    expect(ctx.adapter.writes).toBe(0);
    expect(() => unwrap(result)).toThrow(ChangesetError);
    expect(() => unwrap(result)).toThrow("name can't be blank; slug can't be blank");
  });

  it('unwrap takes the app’s own error type', async () => {
    const result = await projects.insert(() => create({}), context([]));
    class AppError extends Error {}
    expect(() => unwrap(result, (cs) => new AppError(Object.keys(cs.errors).join()))).toThrow(AppError);
  });

  it('turns a declared unique violation into a field error', async () => {
    const result = await projects.insert(() => create({ name: 'Again', slug: 'apollo' }), context());
    expect(result.ok).toBe(false);
    expect(result.changeset.errors).toEqual({ slug: [{ message: 'has already been taken', code: 'unique' }] });
  });

  it('rethrows an undeclared violation', async () => {
    const undeclared = () => CS.of<Project>(null).cast({ name: 'Again', slug: 'apollo' }, fields, ['name', 'slug']);
    await expect(projects.insert(undeclared, context())).rejects.toThrow('unique');
  });

  it('rethrows an error that is not a violation', async () => {
    const ctx = context([]);
    ctx.adapter = Object.assign(fakeAdapter<Project>([], { fail: () => new Error('connection lost') }));
    await expect(projects.insert(() => create({ name: 'Z', slug: 'z' }), ctx)).rejects.toThrow('connection lost');
  });

  it('refuses before anything else when authorize throws', async () => {
    let built = false;
    const ctx = context([], { canWrite: false });
    await expect(
      projects.insert(() => {
        built = true;
        return create({});
      }, ctx)
    ).rejects.toThrow(Forbidden);
    expect(built).toBe(false);
  });

  it('throws when given an update changeset', async () => {
    await expect(projects.insert(() => change(stored(), { name: 'x' }), context())).rejects.toThrow(/for insert/);
  });
});

describe('repo.update', () => {
  it('finds, builds over the row, and writes the changes with update stamps', async () => {
    const ctx = context();
    const result = await projects.update('p1', (row) => change(row, { name: 'Zeus' }), ctx);
    expect(unwrap(result)).toMatchObject({ name: 'Zeus', description: 'stamped' });
    expect(result.changeset.diff()).toEqual({ name: { from: 'Apollo', to: 'Zeus' } });
  });

  it('does not write when nothing changes', async () => {
    const ctx = context();
    const result = await projects.update('p1', (row) => change(row, { name: 'Apollo' }), ctx);
    expect(result).toMatchObject({ ok: true, row: stored() });
    expect(ctx.adapter.writes).toBe(0);
  });

  it('throws not found for a missing row, and for a row find excludes', async () => {
    await expect(projects.update('nope', (row) => change(row, { name: 'x' }), context())).rejects.toThrow(NotFoundError);
    const otherTenant = context([stored({ accountId: 'a2' })]);
    await expect(projects.update('p1', (row) => change(row, { name: 'x' }), otherTenant)).rejects.toThrow(NotFoundError);
  });

  it('throws the configured not-found error', async () => {
    const custom = repo<Project, Partial<Project>, string, Ctx>({
      adapter: (ctx) => ctx.adapter,
      find: (id) => ({ id }),
      notFound: (key) => new Missing(`project ${key}`)
    });
    await expect(custom.update('nope', (row) => row as never, context())).rejects.toThrow('project nope');
  });

  it('throws not found when the row disappears between find and write', async () => {
    const ctx = context();
    const result = projects.update(
      'p1',
      (row) => {
        ctx.rows.length = 0;
        return change(row, { name: 'x' });
      },
      ctx
    );
    await expect(result).rejects.toThrow(NotFoundError);
  });

  it('turns a unique violation on update into a field error', async () => {
    const ctx = context([stored(), stored({ id: 'p2', slug: 'zeus' })]);
    const result = await projects.update(
      'p2',
      (row) => change(row, { slug: 'apollo' }).uniqueConstraint('slug', ['accountId', 'slug']),
      ctx
    );
    expect(result.changeset.errors.slug?.[0]?.code).toBe('unique');
  });
});

describe('protect', () => {
  it('throws when a changeset changes a protected column, even through putChange', async () => {
    const ctx = context();
    await expect(projects.update('p1', (row) => change(row, { ownerId: 'u2' }), ctx)).rejects.toThrow(ProtectedColumnError);
    expect(ctx.adapter.writes).toBe(0);
  });

  it('throws when a prepare step sets a protected column', async () => {
    const ctx = context();
    const build = (row: Project) => change(row, { name: 'x' }).prepare((cs: Changeset<Project>) => cs.putChange('accountId', 'a2'));
    await expect(projects.update('p1', build, ctx)).rejects.toThrow('may not change accountId');
    expect(ctx.adapter.writes).toBe(0);
  });

  it('lets stamps set protected columns, and stamps win over changes', async () => {
    const loose = repo<Project, Partial<Project>, string, Ctx>({
      adapter: (ctx) => ctx.adapter,
      find: (id) => ({ id }),
      stamp: { insert: () => ({ ownerId: 'stamped' }) }
    });
    const result = await loose.insert(() => create({ name: 'Z', slug: 'z' }).putChange('ownerId', 'from-changeset'), context([]));
    expect(unwrap(result).ownerId).toBe('stamped');
  });
});

describe('prepare', () => {
  it('runs after validation, in order, with the context, and its changes are written', async () => {
    const ctx = context();
    const seen: string[] = [];
    const result = await projects.update(
      'p1',
      (row) =>
        change(row, { name: 'zeus' })
          .prepare<Ctx>((cs, c) => {
            seen.push(`first:${c.userId}`);
            return cs.putChange('slug', `${cs.getField('name')}-slug`);
          })
          .prepare(async (cs) => {
            seen.push('second');
            return cs.updateChange('slug', (s) => s.toUpperCase());
          }),
      ctx
    );
    expect(seen).toEqual(['first:u1', 'second']);
    expect(unwrap(result).slug).toBe('ZEUS-SLUG');
    expect(result.changeset.changes).toEqual({ name: 'zeus', slug: 'ZEUS-SLUG' });
  });

  it('does not run when validation fails', async () => {
    let ran = false;
    await projects.insert(
      () =>
        create({}).prepare((cs) => {
          ran = true;
          return cs;
        }),
      context([])
    );
    expect(ran).toBe(false);
  });

  it('can add an error, which stops the write', async () => {
    const ctx = context();
    const result = await projects.update(
      'p1',
      (row) => change(row, { name: 'x' }).prepare(async (cs) => cs.addError('name', 'is on the blocklist', 'blocked')),
      ctx
    );
    expect(result.ok).toBe(false);
    expect(result.changeset.errors.name).toEqual([{ message: 'is on the blocklist', code: 'blocked' }]);
    expect(ctx.adapter.writes).toBe(0);
  });
});
