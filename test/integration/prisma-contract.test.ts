// The adapter contract against each Prisma setup on the Postgres test database.
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import { prismaAdapter } from '../../src/adapters/prisma.js';
import { adapterContract } from '../../src/testing/index.js';
import { connect, resetDatabase, type TestClient } from '../prisma/clients.js';
import { selectedSetups } from '../prisma/setups.mjs';

for (const setup of selectedSetups()) {
  describe(`prisma ${setup.name}`, () => {
    let prisma: TestClient;
    beforeAll(async () => {
      await resetDatabase(setup, 'contract');
      prisma = await connect(setup, 'contract');
    });
    afterAll(() => prisma?.$disconnect());

    adapterContract(
      `prisma ${setup.name}`,
      {
        adapter: () => prismaAdapter(prisma.item),
        reset: async () => {
          await prisma.$executeRawUnsafe('TRUNCATE "items"');
        },
        where: (values) => values,
        constraints: { unique: 'items_sku_key', foreignKey: 'items_parent_id_fkey', check: 'items_qty_check' }
      },
      { describe, it, beforeEach }
    );
  });
}
