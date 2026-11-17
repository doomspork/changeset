// The example files are type-checked and tested in the library repo, so the site renders them from source.
// They import from ../src and a test Prisma client; rewrite those to what an app would write.
import quickStart from '../../../examples/quick-start.ts?raw';
import multiTenant from '../../../examples/multi-tenant.ts?raw';

const forApps = (source: string) =>
  source
    .replace("from '../src/adapters/prisma.js'", "from 'changeset/prisma'")
    .replace("from '../src/index.js'", "from 'changeset'")
    .replace(/from '\.\.\/test\/prisma\/[^']+'/, "from './generated/prisma/client'");

export const examples = { quickStart: forApps(quickStart), multiTenant: forApps(multiTenant) };
