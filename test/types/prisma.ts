// `prismaAdapter(prisma.<model>)` infers the row and where types from each generated client, with no
// explicit type arguments. `pnpm typecheck` needs the clients generated (`pnpm prisma:generate`).
import { z } from 'zod';
import { type Adapter, Changeset, repo } from '../../src/index.js';
import { prismaAdapter } from '../../src/adapters/prisma.js';
import type { PrismaClient as V6Engine } from '../prisma/v6/generated/v6-engine/client/index.js';
import type { PrismaClient as V6Client, Prisma as V6ClientPrisma } from '../prisma/v6/generated/v6-client/client/client.js';
import type { PrismaClient as V7Client, Prisma as V7ClientPrisma } from '../prisma/v7/generated/v7-client/client/client.js';
import type { PrismaClient as V7Js, Prisma as V7JsPrisma } from '../prisma/v7/generated/v7-js/client/index.js';
import type { Prisma as V6EnginePrisma } from '../prisma/v6/generated/v6-engine/client/index.js';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const expectType = <T extends true>(_: T) => {};

interface ProjectRow {
  id: string;
  accountId: string;
  name: string;
  slug: string;
  description: string | null;
  status: 'draft' | 'active' | 'archived';
  priority: number;
  ownerId: string;
  createdAt: Date;
  updatedAt: Date;
}

declare const v6Engine: V6Engine;
declare const v6Client: V6Client;
declare const v7Client: V7Client;
declare const v7Js: V7Js;

type RowOf<A> = A extends Adapter<infer Row, unknown> ? Row : never;
type WhereOf<A> = A extends Adapter<object, infer Where> ? Where : never;

// prisma-client-js, Prisma 6.
{
  const adapter = prismaAdapter(v6Engine.project);
  expectType<Equal<WhereOf<typeof adapter>, V6EnginePrisma.ProjectWhereUniqueInput>>(true);
  expectType<Equal<Omit<RowOf<typeof adapter>, 'settings'>, ProjectRow>>(true);
  expectType<Equal<RowOf<typeof adapter>['settings'], V6EnginePrisma.JsonValue>>(true);
}
// prisma-client, Prisma 6.
{
  const adapter = prismaAdapter(v6Client.project);
  expectType<Equal<WhereOf<typeof adapter>, V6ClientPrisma.ProjectWhereUniqueInput>>(true);
  expectType<Equal<Omit<RowOf<typeof adapter>, 'settings'>, ProjectRow>>(true);
}
// prisma-client, Prisma 7.
{
  const adapter = prismaAdapter(v7Client.project);
  expectType<Equal<WhereOf<typeof adapter>, V7ClientPrisma.ProjectWhereUniqueInput>>(true);
  expectType<Equal<Omit<RowOf<typeof adapter>, 'settings'>, ProjectRow>>(true);
  expectType<Equal<RowOf<typeof adapter>['settings'], V7ClientPrisma.JsonValue>>(true);
}
// prisma-client-js, Prisma 7.
{
  const adapter = prismaAdapter(v7Js.project);
  expectType<Equal<WhereOf<typeof adapter>, V7JsPrisma.ProjectWhereUniqueInput>>(true);
  expectType<Equal<Omit<RowOf<typeof adapter>, 'settings'>, ProjectRow>>(true);
}

// A transaction client's delegate infers the same types.
void v7Client.$transaction(async (tx) => {
  const adapter = prismaAdapter(tx.item);
  expectType<Equal<RowOf<typeof adapter>, RowOf<ReturnType<typeof prismaAdapter<typeof v7Client.item>>>>>(true);
});

// A where is a unique where: an id plus a tenant is fine, a non-unique filter alone is not.
{
  const adapter = prismaAdapter(v7Client.project);
  void adapter.findOne({ id: 'p1', accountId: 'a1' });
  void adapter.findOne({ accountId_slug: { accountId: 'a1', slug: 's' } });
  // @ts-expect-error a where needs a unique key
  void adapter.findOne({ accountId: 'a1' });
  // @ts-expect-error no such column
  void adapter.update({ id: 'p1' }, { title: 'x' });
}

// A repo infers its row, where and context from the adapter, and its key from find.
{
  interface Ctx {
    prisma: V7Client;
    accountId: string;
  }
  const projects = repo({
    adapter: (ctx: Ctx) => prismaAdapter(ctx.prisma.project),
    find: (id: string, ctx) => ({ id, accountId: ctx.accountId })
  });
  void projects.update('p1', (row) => Changeset.of(row).change({ name: 'x' }), { prisma: v7Client, accountId: 'a1' });
  // @ts-expect-error status must be a ProjectStatus
  void projects.update('p1', (row) => Changeset.of(row).change({ status: 'deleted' }), { prisma: v7Client, accountId: 'a1' });
  // @ts-expect-error the key is a string
  void projects.update(1, (row) => Changeset.of(row), { prisma: v7Client, accountId: 'a1' });

  repo({
    adapter: (ctx: Ctx) => prismaAdapter(ctx.prisma.project),
    // @ts-expect-error find must return the adapter's where
    find: (id: string) => ({ slug: id })
  });
}

// castEmbed on a Prisma Json column: any subkeys, with JSON-valued schemas.
{
  type Row = RowOf<ReturnType<typeof prismaAdapter<typeof v7Client.project>>>;
  Changeset.of<Row>(null).castEmbed('settings', { theme: z.string(), digest: z.boolean() }, ['theme', 'digest']);
  // @ts-expect-error a Date is not a JSON value
  Changeset.of<Row>(null).castEmbed('settings', { at: z.date() }, ['at']);
}
