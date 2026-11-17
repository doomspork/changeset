// The multi-tenant example end to end, against each Prisma setup on the Postgres test database.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  archiveProject,
  createProject,
  deleteProject,
  ForbiddenError,
  ProjectNotFoundError,
  type Session,
  updateProject
} from '../../examples/multi-tenant.js';
import { ProtectedColumnError, unwrap } from '../../src/index.js';
import { connect, resetDatabase, type TestClient, truncate } from '../prisma/clients.js';
import { selectedSetups } from '../prisma/setups.mjs';

for (const setup of selectedSetups()) {
  describe(`multi-tenant example on prisma ${setup.name}`, () => {
    let prisma: TestClient;
    let acme: Session;
    let globex: Session;
    let readOnly: Session;
    const as = (session: Session): AppContext => ({ db: prisma, session });
    const session = (accountId: string, userId: string, permissions: string[]): Session => ({
      accountId,
      userId,
      can: (permission) => permissions.includes(permission)
    });

    beforeAll(async () => {
      await resetDatabase(setup, 'tenant');
      prisma = await connect(setup, 'tenant');
    });
    afterAll(() => prisma?.$disconnect());
    beforeEach(async () => {
      await truncate(prisma);
      const all = ['projects:write', 'projects:delete'];
      for (const [name, assign] of [
        ['Acme', (s: Session) => (acme = s)],
        ['Globex', (s: Session) => (globex = s)]
      ] as const) {
        const account = await prisma.account.create({ data: { name } });
        const user = await prisma.user.create({ data: { email: `owner@${name}.test`, accountId: account.id } });
        assign(session(account.id, user.id, all));
      }
      readOnly = session(acme.accountId, acme.userId, []);
    });

    it('creates a project stamped with the session’s account and user, and audits it', async () => {
      const project = unwrap(await createProject({ name: ' Apollo ', slug: 'Apollo', accountId: globex.accountId }, as(acme)));
      expect(project).toMatchObject({ name: 'Apollo', slug: 'apollo', status: 'draft', accountId: acme.accountId, ownerId: acme.userId });
      expect(await prisma.auditEntry.findMany()).toMatchObject([{ projectId: project.id, actorId: acme.userId, action: 'insert' }]);
    });

    it('returns every field error at once', async () => {
      const result = await createProject({ name: '', slug: 'not a slug' }, as(acme));
      expect(result.ok).toBe(false);
      expect(result.changeset.errors).toEqual({
        name: [{ message: "can't be blank", code: 'required' }],
        slug: [{ message: 'may only contain a-z, 0-9 and -', code: 'invalid' }]
      });
    });

    it('reports a duplicate slug in the same account as a field error', async () => {
      unwrap(await createProject({ name: 'Apollo', slug: 'apollo' }, as(acme)));
      const duplicate = await createProject({ name: 'Other', slug: 'apollo' }, as(acme));
      expect(duplicate.ok).toBe(false);
      expect(duplicate.changeset.errors).toEqual({ slug: [{ message: 'has already been taken', code: 'unique' }] });
      // The same slug in another account is fine.
      expect((await createProject({ name: 'Apollo', slug: 'apollo' }, as(globex))).ok).toBe(true);
    });

    it('reads another account’s project as not found, for every write', async () => {
      const project = unwrap(await createProject({ name: 'Apollo', slug: 'apollo' }, as(acme)));
      await expect(updateProject(project.id, 'rename', { name: 'Mine now' }, as(globex))).rejects.toThrow(ProjectNotFoundError);
      await expect(archiveProject(project.id, as(globex))).rejects.toThrow(ProjectNotFoundError);
      await expect(deleteProject(project.id, as(globex))).rejects.toThrow(ProjectNotFoundError);
      expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).name).toBe('Apollo');
    });

    it('refuses a write without permission, before reading anything', async () => {
      await expect(createProject({ name: 'Apollo', slug: 'apollo' }, as(readOnly))).rejects.toThrow(ForbiddenError);
      await expect(updateProject('anything', 'rename', { name: 'x' }, as(readOnly))).rejects.toThrow(ForbiddenError);
      expect(await prisma.project.count()).toBe(0);
    });

    it('follows the status flow, and requires archiving before delete', async () => {
      const project = unwrap(await createProject({ name: 'Apollo', slug: 'apollo' }, as(acme)));
      expect(unwrap(await updateProject(project.id, 'status', { status: 'active' }, as(acme))).status).toBe('active');
      const back = await updateProject(project.id, 'status', { status: 'draft' }, as(acme));
      expect(back.changeset.errors.status).toEqual([{ message: "can't change from active to draft", code: 'transition' }]);

      const early = await deleteProject(project.id, as(acme));
      expect(early.changeset.errors.base).toEqual([{ message: 'archive the project first', code: 'restrict' }]);
      unwrap(await archiveProject(project.id, as(acme)));
      expect(unwrap(await deleteProject(project.id, as(acme))).id).toBe(project.id);
      const actions = (await prisma.auditEntry.findMany({ where: { projectId: project.id } })).map((a) => a.action);
      expect(actions.sort()).toEqual(['delete', 'insert', 'update', 'update']);
    }, 30_000);

    it('ignores unpermitted keys, and an update with no changes writes nothing', async () => {
      const project = unwrap(await createProject({ name: 'Apollo', slug: 'apollo' }, as(acme)));
      const before = await prisma.auditEntry.count();
      const result = await updateProject(project.id, 'rename', { name: 'Apollo', ownerId: globex.userId, accountId: globex.accountId }, as(acme));
      expect(unwrap(result)).toMatchObject({ ownerId: acme.userId, accountId: acme.accountId });
      expect(await prisma.auditEntry.count()).toBe(before);
    });

    it('casts the settings JSON column', async () => {
      const project = unwrap(await createProject({ name: 'Apollo', slug: 'apollo' }, as(acme)));
      const updated = unwrap(await updateProject(project.id, 'settings', { settings: { theme: 'dark', digest: false } }, as(acme)));
      expect(updated.settings).toEqual({ theme: 'dark', digest: false });
    });

    it('writes several projects in one transaction, all or nothing', async () => {
      const failed = await prisma
        .$transaction(async (tx) => {
          unwrap(await createProject({ name: 'One', slug: 'one' }, { db: tx, session: acme }));
          unwrap(await createProject({ name: 'Two', slug: '' }, { db: tx, session: acme }));
        })
        .catch((error: unknown) => error);
      expect(failed).toMatchObject({ name: 'ChangesetError', message: "slug can't be blank" });
      expect(await prisma.project.count()).toBe(0);
    });

    it('a protected column changed by trusted code throws', async () => {
      const project = unwrap(await createProject({ name: 'Apollo', slug: 'apollo' }, as(acme)));
      const { repo } = await import('../../src/index.js');
      const { prismaAdapter } = await import('../../src/adapters/prisma.js');
      const guarded = repo({ adapter: (c: AppContext) => prismaAdapter(c.db.project), find: (id: string) => ({ id }), protect: ['ownerId'] });
      const { Changeset } = await import('../../src/index.js');
      await expect(guarded.update(project.id, (row) => Changeset.of(row).putChange('ownerId', globex.userId), as(acme))).rejects.toThrow(
        ProtectedColumnError
      );
    });
  });
}
