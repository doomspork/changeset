// An app's own rules on top of the library. Every row belongs to an account, the session says which
// account and user are acting, writes need a permission, and every write leaves an audit entry. None of
// this is in the library: it's expressed through `find`, `stamp`, `authorize`, `protect` and `afterWrite`.
import { z } from 'zod';
import { prismaAdapter, type PrismaRow } from '../src/adapters/prisma.js';
import { Changeset, type Field, type Fields, repo } from '../src/index.js';
// In an app, this is your generated client.
import type { PrismaClient } from '../test/prisma/v7/generated/v7-client/client/client.js';

export type Project = PrismaRow<PrismaClient['project']>;

export interface Session {
  accountId: string;
  userId: string;
  can(permission: string): boolean;
}

/** The client, or a transaction client: anything with the delegates the repo uses. */
export type Db = Pick<PrismaClient, 'project' | 'auditEntry'>;

export interface AppContext {
  db: Db;
  session: Session;
}

export class ForbiddenError extends Error {
  override name = 'ForbiddenError';
}
export class ProjectNotFoundError extends Error {
  override name = 'ProjectNotFoundError';
}

/** Columns only the app sets: identity, tenant, ownership, timestamps. */
const PROTECTED = ['id', 'accountId', 'ownerId', 'createdAt', 'updatedAt'] as const;

/** Field schemas may not name a protected column: a schema for one is a compile error. */
type AppFields<T extends object> = Fields<T, Exclude<Field<T>, (typeof PROTECTED)[number]>>;

const projects = repo({
  adapter: ({ db }: AppContext) => prismaAdapter(db.project),
  // Another account's row is indistinguishable from a missing one: the tenant is part of every where.
  find: (id: string, { session }) => ({ id, accountId: session.accountId }),
  authorize: (action, { session }) => {
    if (!session.can(action === 'delete' ? 'projects:delete' : 'projects:write')) throw new ForbiddenError();
  },
  stamp: { insert: ({ session }) => ({ accountId: session.accountId, ownerId: session.userId }) },
  protect: PROTECTED,
  lock: ['updatedAt'],
  afterWrite: async (row, changeset, { db, session }, action) => {
    await db.auditEntry.create({
      data: { projectId: row.id, actorId: session.userId, action, diff: JSON.parse(JSON.stringify(changeset.diff())) }
    });
  },
  notFound: () => new ProjectNotFoundError()
});

const projectFields = {
  name: z.string().trim().min(1).max(120),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9-]+$/, 'may only contain a-z, 0-9 and -'),
  status: z.enum(['draft', 'active', 'archived'])
} satisfies AppFields<Project>;

const settingsFields = { theme: z.enum(['light', 'dark']), digest: z.boolean() };

const STATUS_FLOW = { draft: ['active', 'archived'], active: ['archived'], archived: ['active'] } as const;

/** Each named changeset is one way a project may be written. */
export const projectChangesets = {
  create: (attrs: unknown) =>
    Changeset.of<Project>(null)
      .cast(attrs, projectFields, ['name', 'slug'])
      .putChange('status', 'draft')
      .validateRequired(['name', 'slug'])
      .uniqueConstraint('slug', ['accountId', 'slug']),
  rename: (row: Project, attrs: unknown) =>
    Changeset.of(row)
      .cast(attrs, projectFields, ['name', 'slug'])
      .validateRequired(['name', 'slug'])
      .uniqueConstraint('slug', ['accountId', 'slug']),
  status: (row: Project, attrs: unknown) =>
    Changeset.of(row).cast(attrs, projectFields, ['status']).validateRequired(['status']).validateTransition('status', STATUS_FLOW),
  settings: (row: Project, attrs: unknown) => Changeset.of(row).cast(attrs, {}, []).castEmbed('settings', settingsFields, ['theme', 'digest']),
  archive: (row: Project) => Changeset.of(row).putChange('status', 'archived').validateTransition('status', STATUS_FLOW),
  remove: (row: Project) =>
    Changeset.of(row).check('base', ({ data }) => (data?.status === 'archived' ? null : 'archive the project first'), 'restrict')
};

export type ProjectEdit = 'rename' | 'status' | 'settings';

// Four functions cover every project write.
export const createProject = (attrs: unknown, context: AppContext) => projects.insert(() => projectChangesets.create(attrs), context);
export const updateProject = (id: string, edit: ProjectEdit, attrs: unknown, context: AppContext) =>
  projects.update(id, (row) => projectChangesets[edit](row, attrs), context);
export const archiveProject = (id: string, context: AppContext) => projects.update(id, (row) => projectChangesets.archive(row), context);
export const deleteProject = (id: string, context: AppContext) => projects.delete(id, (row) => projectChangesets.remove(row), context);

// @ts-expect-error accountId is protected, so it can't have a field schema
const leak = { accountId: z.string() } satisfies AppFields<Project>;
void leak;
