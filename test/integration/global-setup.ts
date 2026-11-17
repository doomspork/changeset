// Fails fast, with a hint, when the test database isn't up.
import pg from 'pg';
import { DATABASE_URL } from '../prisma/setups.mjs';

export default async function setup(): Promise<void> {
  const client = new pg.Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
  } catch (error) {
    throw new Error(
      `The integration tests need Postgres at ${DATABASE_URL}. Start it with \`pnpm db:up\`, or run \`pnpm test:unit\`.\n${String(error)}`
    );
  } finally {
    await client.end().catch(() => {});
  }
}
