// The Prisma setups the integration tests run against: each Prisma major, each generator, with and
// without a driver adapter. `PRISMA_SETUPS=v7-client,v6-engine` narrows the list.
export const SETUPS = [
  { name: 'v6-engine', major: 6, generator: 'prisma-client-js', driverAdapter: false },
  { name: 'v6-adapter', major: 6, generator: 'prisma-client-js', driverAdapter: true },
  { name: 'v6-client', major: 6, generator: 'prisma-client', driverAdapter: false },
  { name: 'v7-client', major: 7, generator: 'prisma-client', driverAdapter: true },
  { name: 'v7-js', major: 7, generator: 'prisma-client-js', driverAdapter: true }
];

export const selectedSetups = () => {
  const only = process.env.PRISMA_SETUPS?.split(',').map((s) => s.trim()).filter(Boolean);
  return only?.length ? SETUPS.filter((setup) => only.includes(setup.name)) : SETUPS;
};

export const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://changeset:changeset@localhost:54329/changeset_test';
