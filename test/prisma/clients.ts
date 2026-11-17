// Connects each Prisma setup to its own Postgres schema, so setups can run side by side.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import type { PrismaClient } from './v7/generated/v7-client/client/client.js';
import { DATABASE_URL, type PrismaSetup } from './setups.mjs';

export type Setup = PrismaSetup;
/** Every setup's client has the same models; the tests use the newest generator's types for all of them. */
export type TestClient = PrismaClient;

const sql = readFileSync(join(import.meta.dirname, 'schema.sql'), 'utf8');
/** One Postgres schema per setup and test file, so files can run in parallel. */
const schemaName = (setup: Setup, scope: string) => `${scope}_${setup.name}`.replace(/-/g, '_');

/** Drops and recreates the setup's Postgres schema from schema.sql. */
export async function resetDatabase(setup: Setup, scope: string): Promise<void> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const schema = schemaName(setup, scope);
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE; CREATE SCHEMA "${schema}"; SET search_path TO "${schema}";`);
    await client.query(sql);
  } finally {
    await client.end();
  }
}

/** Deletes every row, children first. */
export async function truncate(prisma: TestClient): Promise<void> {
  await prisma.$executeRawUnsafe('TRUNCATE "audit_entries", "projects", "users", "accounts", "items" CASCADE');
}

export async function connect(setup: Setup, scope: string): Promise<TestClient> {
  const dir = join(import.meta.dirname, `v${setup.major}`, 'generated', setup.name, 'client');
  const entry = setup.generator === 'prisma-client' ? join(dir, 'client.ts') : join(dir, 'index.js');
  const { PrismaClient } = (await import(entry)) as { PrismaClient: new (options?: object) => TestClient };
  const schema = schemaName(setup, scope);
  if (!setup.driverAdapter) {
    const url = `${DATABASE_URL}${DATABASE_URL.includes('?') ? '&' : '?'}schema=${schema}`;
    return new PrismaClient({ datasources: { db: { url } } });
  }
  const adapterPath = join(import.meta.dirname, `v${setup.major}`, 'node_modules', '@prisma', 'adapter-pg', 'dist', 'index.mjs');
  const { PrismaPg } = (await import(adapterPath)) as { PrismaPg: new (config: object, options: object) => unknown };
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL, options: `-c search_path=${schema}` }, { schema }) });
}
