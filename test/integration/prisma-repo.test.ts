// Repo features that depend on the database: stale writes on an @updatedAt column, restricted deletes,
// an audit entry in the same transaction, and a JSON column.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { prismaAdapter, type PrismaRow } from '../../src/adapters/prisma.js';
import { Changeset, change, repo, STALE_MESSAGE, unwrap } from '../../src/index.js';
import { connect, resetDatabase, type TestClient, truncate } from '../prisma/clients.js';
import { selectedSetups } from '../prisma/setups.mjs';

type Project = PrismaRow<TestClient['project']>;
type Db = Pick<TestClient, 'project' | 'auditEntry' | 'user'>;
interface Ctx {
  db: Db;
  actorId: string;
}

const projects = repo({
  adapter: (ctx: Ctx) => prismaAdapter(ctx.db.project),
  find: (id: string) => ({ id }),
  lock: ['updatedAt'],
  afterWrite: async (row, changeset, ctx, action) => {
    await ctx.db.auditEntry.create({
      data: { projectId: row.id, actorId: ctx.actorId, action, diff: JSON.parse(JSON.stringify(changeset.diff())) }
    });
  }
});

const settingsFields = { theme: z.enum(['light', 'dark']), digest: z.boolean() };

for (const setup of selectedSetups()) {
  describe(`prisma ${setup.name} repo`, () => {
    let prisma: TestClient;
    let accountId: string;
    let ownerId: string;
    let project: Project;
    const ctx = (): Ctx => ({ db: prisma, actorId: ownerId });

    beforeAll(async () => {
      await resetDatabase(setup, 'repo');
      prisma = await connect(setup, 'repo');
    });
    afterAll(() => prisma?.$disconnect());
    beforeEach(async () => {
      await truncate(prisma);
      accountId = (await prisma.account.create({ data: { name: 'Acme' } })).id;
      ownerId = (await prisma.user.create({ data: { email: 'o@acme.test', accountId } })).id;
      project = await prisma.project.create({ data: { name: 'Apollo', slug: 'apollo', accountId, ownerId, settings: { theme: 'light', digest: true } } });
    });

    it('updates when updatedAt is unchanged, and records the audit entry', async () => {
      const result = await projects.update(project.id, (row) => change(row, { name: 'Zeus' }), ctx());
      expect(unwrap(result).name).toBe('Zeus');
      expect(unwrap(result).updatedAt.getTime()).toBeGreaterThanOrEqual(project.updatedAt.getTime());
      const audits = await prisma.auditEntry.findMany();
      expect(audits).toMatchObject([{ action: 'update', diff: { name: { from: 'Apollo', to: 'Zeus' } } }]);
    });

    it('reports a stale write when another writer updated the row after it was read', async () => {
      const result = await projects.update(
        project.id,
        (row) =>
          change(row, { name: 'Mine' }).prepare<Ctx>(async (changeset, c) => {
            // Another writer, between this read and this write. Its updatedAt is set explicitly so the two
            // can't land in the same millisecond.
            const later = new Date(project.updatedAt.getTime() + 1000);
            await c.db.project.update({ where: { id: project.id }, data: { name: 'Theirs', updatedAt: later } });
            return changeset;
          }),
        ctx()
      );
      expect(result.ok).toBe(false);
      expect(result.changeset.errors).toEqual({ base: [{ message: STALE_MESSAGE, code: 'stale' }] });
      expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).name).toBe('Theirs');
      expect(await prisma.auditEntry.count()).toBe(0);
    });

    it('rolls the write back with the transaction when the audit entry fails', async () => {
      const failing = await prisma
        .$transaction(async (tx) => {
          await projects.update(project.id, (row) => change(row, { name: 'Zeus' }), { db: tx, actorId: ownerId });
          throw new Error('abort after audit');
        })
        .catch((error: unknown) => error);
      expect(String(failing)).toContain('abort after audit');
      expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).name).toBe('Apollo');
      expect(await prisma.auditEntry.count()).toBe(0);
    });

    it('deletes a row, and reports a restricted delete as a field error', async () => {
      const users = repo({
        adapter: (c: Ctx) => prismaAdapter(c.db.user),
        find: (id: string) => ({ id })
      });
      const restricted = await users.delete(
        ownerId,
        (row) => Changeset.of(row).foreignKeyConstraint('id', 'projects_owner_id_fkey', { message: 'still owns projects' }),
        ctx()
      );
      expect(restricted.changeset.errors).toEqual({ id: [{ message: 'still owns projects', code: 'foreign_key' }] });

      await prisma.auditEntry.deleteMany();
      const deleteProject = repo({ adapter: (c: Ctx) => prismaAdapter(c.db.project), find: (id: string) => ({ id }), lock: ['updatedAt'] });
      const removed = await deleteProject.delete(project.id, (row) => Changeset.of(row), ctx());
      expect(unwrap(removed).id).toBe(project.id);
      expect(await prisma.project.count()).toBe(0);
    });

    it('casts a JSON column, changing only the subkeys given', async () => {
      const result = await projects.update(
        project.id,
        (row) => Changeset.of(row).cast({ settings: { theme: 'dark' } }, {}, []).castEmbed('settings', settingsFields, ['theme', 'digest']),
        ctx()
      );
      expect(unwrap(result).settings).toEqual({ theme: 'dark', digest: true });
      const invalid = await projects.update(
        project.id,
        (row) => Changeset.of(row).cast({ settings: { theme: 'neon' } }, {}, []).castEmbed('settings', settingsFields, ['theme']),
        ctx()
      );
      expect(Object.keys(invalid.changeset.errors)).toEqual(['settings.theme']);
    });
  });
}
