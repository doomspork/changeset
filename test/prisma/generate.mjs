// Generates one Prisma client per setup into test/prisma/v<major>/generated/<setup>.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectedSetups } from './setups.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const models = readFileSync(join(here, 'models.prisma'), 'utf8');

for (const setup of selectedSetups()) {
  const pkg = join(here, `v${setup.major}`);
  const out = join(pkg, 'generated', setup.name);
  mkdirSync(out, { recursive: true });
  const features = '';
  const generator =
    setup.generator === 'prisma-client'
      ? `generator client {\n  provider = "prisma-client"\n  output = "./client"\n  moduleFormat = "esm"${features}\n}`
      : `generator client {\n  provider = "prisma-client-js"\n  output = "./client"${features}\n}`;
  const url = setup.major === 6 ? '\n  url = env("DATABASE_URL")' : '';
  const schema = `${generator}\n\ndatasource db {\n  provider = "postgresql"${url}\n}\n\n${models}`;
  writeFileSync(join(out, 'schema.prisma'), schema);
  if (setup.major === 7) {
    writeFileSync(
      join(out, 'prisma.config.ts'),
      `export default { schema: './schema.prisma', datasource: { url: process.env.DATABASE_URL ?? '' } };\n`
    );
  }
  const args = setup.major === 7 ? ['generate', '--config', join(out, 'prisma.config.ts')] : ['generate', '--schema', join(out, 'schema.prisma')];
  console.log(`generating ${setup.name}`);
  execFileSync(join(pkg, 'node_modules', '.bin', 'prisma'), args, { cwd: pkg, stdio: 'inherit', env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: '1' } });
}
