export interface PrismaSetup {
  name: 'v6-engine' | 'v6-adapter' | 'v6-client' | 'v7-client' | 'v7-js';
  major: 6 | 7;
  generator: 'prisma-client-js' | 'prisma-client';
  driverAdapter: boolean;
}
export declare const SETUPS: readonly PrismaSetup[];
export declare const selectedSetups: () => readonly PrismaSetup[];
export declare const DATABASE_URL: string;
