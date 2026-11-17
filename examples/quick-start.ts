// Plain Prisma, no tenancy: named changesets for a project and a repo that writes them.
import { z } from 'zod';
import { prismaAdapter, type PrismaRow } from '../src/adapters/prisma.js';
import { Changeset, type Fields, repo, unwrap } from '../src/index.js';
// In an app, this is your generated client.
import type { PrismaClient } from '../test/prisma/v7/generated/v7-client/client/client.js';

type Project = PrismaRow<PrismaClient['project']>;

const fields = {
  name: z.string().trim().min(1).max(120),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9-]+$/, 'may only contain a-z, 0-9 and -'),
  description: z.string().max(2000).nullable()
} satisfies Fields<Project>;

export const projectChangesets = {
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

const projects = repo({
  adapter: (prisma: PrismaClient) => prismaAdapter(prisma.project),
  find: (id: string) => ({ id })
});

export async function createProject(prisma: PrismaClient, attrs: unknown, owner: { accountId: string; ownerId: string }) {
  const result = await projects.insert(() => projectChangesets.create(attrs, owner), prisma);
  // `result.ok` is false for invalid input or a taken slug; `result.changeset.errors` says why, by field.
  return result;
}

export async function editProject(prisma: PrismaClient, id: string, attrs: unknown): Promise<Project> {
  // `unwrap` returns the row, or throws a ChangesetError carrying the changeset.
  return unwrap(await projects.update(id, (project) => projectChangesets.edit(project, attrs), prisma));
}
