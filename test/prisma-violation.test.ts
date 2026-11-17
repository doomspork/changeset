// prismaViolation against the error shapes each Prisma setup produced from the Postgres test database
// (see test/integration/prisma-errors.test.ts, which checks the same against live errors), plus older shapes.
import { describe, expect, it } from 'vitest';
import { type PrismaModelInfo, prismaViolation } from '../src/adapters/prisma.js';

const projects: PrismaModelInfo = {
  table: 'projects',
  fields: { id: 'id', account_id: 'accountId', slug: 'slug', name: 'name', owner_id: 'ownerId', priority: 'priority' }
};
const known = (code: string, meta: object) => Object.assign(new Error('x'), { name: 'PrismaClientKnownRequestError', code, meta });
const adapterError = (code: string, cause: object) => known(code, { modelName: 'Project', driverAdapterError: { name: 'DriverAdapterError', cause } });

describe('prismaViolation: query engine shape (Prisma 6)', () => {
  const unique = known('P2002', { modelName: 'Project', target: ['account_id', 'slug'] });

  it('maps database columns in meta.target to field names', () => {
    expect(prismaViolation(unique, projects)).toEqual({ kind: 'unique', columns: ['accountId', 'slug'] });
  });

  it('keeps database column names without model info', () => {
    expect(prismaViolation(unique)).toEqual({ kind: 'unique', columns: ['account_id', 'slug'] });
  });

  it('reads an index name in meta.target', () => {
    expect(prismaViolation(known('P2002', { target: 'projects_account_id_slug_key' }), projects)).toEqual({
      kind: 'unique',
      constraint: 'projects_account_id_slug_key',
      columns: ['accountId', 'slug']
    });
  });

  it('reads a foreign key from meta.constraint, deriving its columns', () => {
    expect(prismaViolation(known('P2003', { modelName: 'Project', constraint: 'projects_owner_id_fkey' }), projects)).toEqual({
      kind: 'foreign_key',
      constraint: 'projects_owner_id_fkey',
      columns: ['ownerId']
    });
  });

  it('reads meta.field_name, as a column or as a constraint', () => {
    expect(prismaViolation(known('P2003', { field_name: 'owner_id' }), projects)).toEqual({ kind: 'foreign_key', columns: ['ownerId'] });
    expect(prismaViolation(known('P2003', { field_name: 'ownerId' }))).toEqual({ kind: 'foreign_key', columns: ['ownerId'] });
    expect(prismaViolation(known('P2003', { field_name: 'projects_owner_id_fkey (index)' }), projects)).toEqual({
      kind: 'foreign_key',
      constraint: 'projects_owner_id_fkey',
      columns: ['ownerId']
    });
  });

  it('reads a check violation from an unknown-request error message', () => {
    const error = Object.assign(new Error(
      'Error occurred during query execution:\nConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "23514", message: "new row for relation \\"projects\\" violates check constraint \\"projects_priority_check\\"", severity: "ERROR", detail: None }), transient: false })'
    ), { name: 'PrismaClientUnknownRequestError' });
    expect(prismaViolation(error, projects)).toEqual({ kind: 'check', constraint: 'projects_priority_check', columns: ['priority'] });
  });
});

describe('prismaViolation: driver adapter shape (Prisma 7)', () => {
  it('reads a unique violation by index name, deriving its columns', () => {
    const error = adapterError('P2002', {
      originalCode: '23505',
      kind: 'UniqueConstraintViolation',
      constraint: { index: 'projects_account_id_slug_key' },
      table: 'projects'
    });
    expect(prismaViolation(error, projects)).toEqual({ kind: 'unique', constraint: 'projects_account_id_slug_key', columns: ['accountId', 'slug'] });
    expect(prismaViolation(error)).toEqual({ kind: 'unique', constraint: 'projects_account_id_slug_key' });
  });

  it('reads constraint.fields when the adapter reports them', () => {
    const error = adapterError('P2002', { kind: 'UniqueConstraintViolation', constraint: { fields: ['account_id', 'slug'] } });
    expect(prismaViolation(error, projects)).toEqual({ kind: 'unique', columns: ['accountId', 'slug'] });
  });

  it('reads a foreign-key violation', () => {
    const error = adapterError('P2003', { originalCode: '23503', kind: 'ForeignKeyConstraintViolation', constraint: { index: 'projects_owner_id_fkey' } });
    expect(prismaViolation(error, projects)).toEqual({ kind: 'foreign_key', constraint: 'projects_owner_id_fkey', columns: ['ownerId'] });
  });

  it('reads a check violation from its SQLSTATE and message', () => {
    const error = adapterError('P2039', {
      originalCode: '23514',
      originalMessage: 'new row for relation "projects" violates check constraint "projects_priority_check"',
      kind: 'postgres'
    });
    expect(prismaViolation(error, projects)).toEqual({ kind: 'check', constraint: 'projects_priority_check', columns: ['priority'] });
  });
});

describe('prismaViolation: anything else', () => {
  it('returns null', () => {
    for (const error of [null, undefined, 'P2002', new Error('x'), known('P2025', {}), adapterError('P2010', { kind: 'postgres', originalCode: '42P01' })]) {
      expect(prismaViolation(error, projects)).toBeNull();
    }
  });

  it('derives no columns from a custom constraint name, or an ambiguous one', () => {
    expect(prismaViolation(known('P2003', { constraint: 'owner_must_exist' }), projects)).toEqual({ kind: 'foreign_key', constraint: 'owner_must_exist' });
    const ambiguous: PrismaModelInfo = { table: 't', fields: { a: 'a', b: 'b', a_b: 'aB' } };
    expect(prismaViolation(known('P2003', { constraint: 't_a_b_fkey' }), ambiguous)).toEqual({ kind: 'foreign_key', constraint: 't_a_b_fkey' });
  });
});
