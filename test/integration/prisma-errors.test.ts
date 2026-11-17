// What each Prisma setup reports for each constraint failure on Postgres, read from live errors. The
// expected values here are the ones documented in the README.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prismaAdapter, prismaModelInfo, prismaViolation } from '../../src/adapters/prisma.js';
import { connect, resetDatabase, type TestClient, truncate } from '../prisma/clients.js';
import { selectedSetups } from '../prisma/setups.mjs';

const fail = async (run: () => PromiseLike<unknown>) => {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('expected an error');
};

for (const setup of selectedSetups()) {
  const engine = setup.major === 6;
  describe(`prisma ${setup.name} errors`, () => {
    let prisma: TestClient;
    let accountId: string;
    let ownerId: string;
    beforeAll(async () => {
      await resetDatabase(setup, 'errors');
      prisma = await connect(setup, 'errors');
      await truncate(prisma);
      accountId = (await prisma.account.create({ data: { name: 'Acme' } })).id;
      ownerId = (await prisma.user.create({ data: { email: 'o@acme.test', accountId } })).id;
      await prisma.project.create({ data: { name: 'Apollo', slug: 'apollo', accountId, ownerId } });
    });
    afterAll(() => prisma?.$disconnect());

    it('exposes the model’s table and column names', () => {
      expect(prismaModelInfo(prisma.project)).toMatchObject({
        table: 'projects',
        fields: { id: 'id', account_id: 'accountId', owner_id: 'ownerId', slug: 'slug' }
      });
    });

    it('reports a compound unique violation on mapped columns', async () => {
      const error = await fail(() => prisma.project.create({ data: { name: 'Again', slug: 'apollo', accountId, ownerId } }));
      // The raw shape: database columns from the engine, the index name from the driver adapter.
      if (engine) expect(error).toMatchObject({ code: 'P2002', meta: { target: ['account_id', 'slug'] } });
      else expect(error).toMatchObject({ code: 'P2002', meta: { driverAdapterError: { cause: { kind: 'UniqueConstraintViolation', constraint: { index: 'projects_account_id_slug_key' } } } } });
      expect(prismaAdapter(prisma.project).violation(error)).toEqual({
        kind: 'unique',
        columns: ['accountId', 'slug'],
        ...(engine ? {} : { constraint: 'projects_account_id_slug_key' })
      });
      expect(prismaViolation(error)).toEqual(engine ? { kind: 'unique', columns: ['account_id', 'slug'] } : { kind: 'unique', constraint: 'projects_account_id_slug_key' });
    });

    it('reports a foreign-key violation by constraint name, with derived columns', async () => {
      const error = await fail(() =>
        prisma.project.create({ data: { name: 'X', slug: 'x', accountId, ownerId: '00000000-0000-0000-0000-000000000000' } })
      );
      expect(error).toMatchObject({ code: 'P2003' });
      expect(prismaAdapter(prisma.project).violation(error)).toEqual({ kind: 'foreign_key', constraint: 'projects_owner_id_fkey', columns: ['ownerId'] });
    });

    it('reports a restricted delete as a foreign-key violation', async () => {
      const error = await fail(() => prisma.user.delete({ where: { id: ownerId } }));
      expect(prismaAdapter(prisma.user).violation(error)).toEqual({ kind: 'foreign_key', constraint: 'projects_owner_id_fkey' });
    });

    it('reports a check violation', async () => {
      const error = await fail(() => prisma.project.create({ data: { name: 'X', slug: 'y', accountId, ownerId, priority: 11 } }));
      // No error code from the engine (an unknown-request error); P2039 with SQLSTATE 23514 from the driver adapter.
      if (engine) expect(error).toMatchObject({ name: 'PrismaClientUnknownRequestError' });
      else expect(error).toMatchObject({ code: 'P2039', meta: { driverAdapterError: { cause: { originalCode: '23514' } } } });
      expect(prismaAdapter(prisma.project).violation(error)).toEqual({ kind: 'check', constraint: 'projects_priority_check', columns: ['priority'] });
    });

    it('returns null for a not-found error', async () => {
      const error = await fail(() => prisma.project.update({ where: { id: '00000000-0000-0000-0000-000000000000' }, data: { name: 'x' } }));
      expect(error).toMatchObject({ code: 'P2025' });
      expect(prismaAdapter(prisma.project).violation(error)).toBeNull();
    });

    it('works on a transaction client', async () => {
      await prisma.$transaction(async (tx) => {
        const adapter = prismaAdapter(tx.project);
        const error = await fail(() => adapter.insert({ name: 'Again', slug: 'apollo', accountId, ownerId }));
        expect(adapter.violation(error)).toMatchObject({ kind: 'unique', columns: ['accountId', 'slug'] });
      }).catch((error: unknown) => {
        // Postgres aborts the transaction after the failed statement; the test only needs the violation.
        if (!String(error).includes('current transaction is aborted')) throw error;
      });
    });
  });
}
