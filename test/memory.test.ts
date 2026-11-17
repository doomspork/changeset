import { beforeEach, describe, expect, it } from 'vitest';
import { memoryAdapter, MemoryConstraintError } from '../src/adapters/memory.js';
import { adapterContract, type ContractItem } from '../src/testing/index.js';

let next = 0;
const items: ContractItem[] = [];
const table = () =>
  memoryAdapter<ContractItem>({
    rows: items,
    defaults: (data) => ({ id: `00000000-0000-0000-0000-${String(++next).padStart(12, '0')}`, qty: 0, parentId: null, sku: '', name: '', ...data }),
    unique: [{ name: 'items_sku_key', columns: ['sku'] }],
    foreignKeys: [{ name: 'items_parent_id_fkey', columns: ['parentId'], references: () => items }],
    referencedBy: [{ name: 'items_parent_id_fkey', rows: () => items, columns: ['parentId'] }],
    checks: [{ name: 'items_qty_check', columns: ['qty'], test: (row) => row.qty >= 0 }]
  });

adapterContract(
  'memory',
  {
    adapter: table,
    reset: () => {
      items.length = 0;
    },
    where: (values) => values,
    constraints: { unique: 'items_sku_key', foreignKey: 'items_parent_id_fkey', check: 'items_qty_check' }
  },
  { describe, it, beforeEach }
);

describe('memoryAdapter', () => {
  interface Row {
    id: number;
    email: string | null;
    touched: number;
  }
  const make = (rows: Row[] = []) =>
    memoryAdapter<Row>({
      rows,
      defaults: (data) => ({ id: rows.length + 1, email: null, touched: 0, ...data }),
      onUpdate: (row) => ({ touched: row.touched + 1 }),
      unique: [{ columns: ['email'] }]
    });

  it('reports columns, and a name only when given one', async () => {
    const adapter = make();
    await adapter.insert({ email: 'a' });
    const error = await adapter.insert({ email: 'a' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MemoryConstraintError);
    expect(adapter.violation(error)).toEqual({ kind: 'unique', columns: ['email'] });
  });

  it('lets nulls repeat in a unique column', async () => {
    const adapter = make();
    await adapter.insert({});
    await expect(adapter.insert({})).resolves.toMatchObject({ email: null });
  });

  it('runs onUpdate on every update', async () => {
    const adapter = make();
    const row = await adapter.insert({ email: 'a' });
    expect(await adapter.update({ id: row.id }, { email: 'b' })).toMatchObject({ email: 'b', touched: 1 });
  });

  it('narrows a where to nothing when a value conflicts with it', async () => {
    const adapter = make();
    const row = await adapter.insert({ email: 'a' });
    expect(await adapter.findOne(adapter.narrow({ id: row.id, email: 'a' }, { email: 'b' }))).toBeNull();
    expect(await adapter.findOne(adapter.narrow({ id: row.id, email: 'a' }, { email: 'a' }))).toMatchObject({ id: row.id });
  });

  it('shares its rows with the caller', async () => {
    const rows: Row[] = [{ id: 7, email: 'seeded', touched: 0 }];
    const adapter = make(rows);
    expect(await adapter.findOne({ email: 'seeded' })).toEqual(rows[0]);
    expect(adapter.rows).toBe(rows);
  });
});
