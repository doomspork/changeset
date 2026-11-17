import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { memoryAdapter } from '../src/adapters/memory.js';
import { type Action, Changeset, change, NotFoundError, repo, STALE_MESSAGE, unwrap } from '../src/index.js';

interface Address {
  line1: string;
  city: string;
  zip: string | null;
}

interface Customer {
  id: number;
  name: string;
  status: 'active' | 'closed';
  address: Address;
  settings: { theme: 'light' | 'dark'; digest: boolean } | null;
  version: number;
}

const addressFields = {
  line1: z.string().trim().min(1),
  city: z.string().trim().min(2, 'is too short'),
  zip: z.string().regex(/^\d{5}$/, 'is not a zip').nullable()
};
const settingsFields = { theme: z.enum(['light', 'dark']), digest: z.boolean() };

const stored = (): Customer => ({
  id: 1,
  name: 'Ada',
  status: 'active',
  address: { line1: '1 Main St', city: 'Springfield', zip: '12345' },
  settings: null,
  version: 1
});

const castCustomer = (row: Customer | null, attrs: unknown) =>
  Changeset.of<Customer>(row)
    .cast(attrs, { name: z.string() }, ['name'])
    .castEmbed('address', addressFields, ['line1', 'city', 'zip'])
    .castEmbed('settings', settingsFields, ['theme', 'digest']);

describe('castEmbed', () => {
  it('changes only the subkeys present, keeping the others', () => {
    const changeset = castCustomer(stored(), { address: { city: ' Shelbyville ' } });
    expect(changeset.changes).toEqual({ address: { line1: '1 Main St', city: 'Shelbyville', zip: '12345' } });
    expect(changeset.diff().address?.from).toEqual(stored().address);
  });

  it('reports a nested error as key.subkey, and leaves the column unchanged', () => {
    const changeset = castCustomer(stored(), { address: { city: 'X', zip: 'nope', line1: 'ok' } });
    expect(changeset.errors).toEqual({
      'address.city': [{ message: 'is too short', code: 'invalid' }],
      'address.zip': [{ message: 'is not a zip', code: 'invalid' }]
    });
    expect(changeset.changes).toEqual({});
  });

  it('follows the cast rules: blank to null, blank into non-null, equal values, unpermitted subkeys', () => {
    expect(castCustomer(stored(), { address: { zip: '  ' } }).changes).toEqual({ address: { ...stored().address, zip: null } });
    expect(castCustomer(stored(), { address: { line1: '' } }).errors).toEqual({ 'address.line1': [{ message: "can't be blank", code: 'required' }] });
    expect(castCustomer(stored(), { address: { city: 'Springfield', country: 'XX' } }).changes).toEqual({});
  });

  it('leaves the column alone when its key is absent', () => {
    expect(castCustomer(stored(), { name: 'Bea' }).changes).toEqual({ name: 'Bea' });
  });

  it('rejects a value that is not an object', () => {
    expect(castCustomer(stored(), { address: 'Main St' }).errors).toEqual({ address: [{ message: 'is invalid', code: 'invalid' }] });
    expect(castCustomer(stored(), { address: null }).errors.address?.[0]?.code).toBe('invalid');
  });

  it('builds a value from nothing on an insert, or over a null column', () => {
    expect(castCustomer(null, { address: { line1: 'a', city: 'bb' } }).changes).toEqual({ address: { line1: 'a', city: 'bb' } });
    expect(castCustomer(stored(), { settings: { theme: 'dark' } }).changes).toEqual({ settings: { theme: 'dark' } });
  });

  it('reports the path inside a nested schema', () => {
    const changeset = Changeset.of(stored())
      .cast({ address: { line1: { street: 5 } } }, {}, [])
      .castEmbed('address', { line1: z.object({ street: z.string() }) as never }, ['line1']);
    expect(Object.keys(changeset.errors)).toEqual(['address.line1.street']);
  });
});

describe('check', () => {
  it('adds an error from a rule on the whole changeset', () => {
    const closed = (cs: Changeset<Customer>) => (cs.getField('status') === 'closed' ? null : 'close the account first');
    expect(Changeset.of(stored()).check('base', closed, 'restrict').errors).toEqual({
      base: [{ message: 'close the account first', code: 'restrict' }]
    });
    expect(Changeset.of<Customer>({ ...stored(), status: 'closed' }).check('base', closed).valid).toBe(true);
  });
});

describe('repo extensions', () => {
  interface Ctx {
    log: string[];
  }
  const setup = (options: { lock?: boolean } = {}) => {
    const rows = [stored()];
    const audits: { action: Action; id: number; diff: unknown }[] = [];
    const adapter = memoryAdapter<Customer>({
      rows,
      defaults: (data) => ({ ...stored(), id: rows.length + 1, ...data }),
      onUpdate: (row) => ({ version: row.version + 1 })
    });
    const customers = repo<Customer, Partial<Customer>, number, Ctx>({
      adapter: () => adapter,
      find: (id) => ({ id }),
      ...(options.lock && { lock: ['version'] as const }),
      afterWrite: (row, changeset, ctx, action) => {
        ctx.log.push(action);
        audits.push({ action, id: row.id, diff: changeset.diff() });
      }
    });
    return { rows, audits, adapter, customers };
  };

  describe('lock', () => {
    it('writes when the locked columns are unchanged', async () => {
      const { customers } = setup({ lock: true });
      const result = await customers.update(1, (row) => change(row, { name: 'Bea' }), { log: [] });
      expect(unwrap(result)).toMatchObject({ name: 'Bea', version: 2 });
    });

    it('turns a write over a changed row into a stale base error', async () => {
      const { customers, rows } = setup({ lock: true });
      const result = await customers.update(
        1,
        (row) => {
          rows[0] = { ...rows[0]!, name: 'Someone else', version: 2 };
          return change(row, { name: 'Bea' });
        },
        { log: [] }
      );
      expect(result.ok).toBe(false);
      expect(result.changeset.errors).toEqual({ base: [{ message: STALE_MESSAGE, code: 'stale' }] });
      expect(rows[0]?.name).toBe('Someone else');
    });

    it('still throws not found when the row is gone', async () => {
      const { customers, rows } = setup({ lock: true });
      const gone = customers.update(
        1,
        (row) => {
          rows.length = 0;
          return change(row, { name: 'Bea' });
        },
        { log: [] }
      );
      await expect(gone).rejects.toThrow(NotFoundError);
    });

    it('applies to deletes', async () => {
      const { customers, rows } = setup({ lock: true });
      const result = await customers.delete(
        1,
        (row) => {
          rows[0] = { ...rows[0]!, version: 9 };
          return Changeset.of(row);
        },
        { log: [] }
      );
      expect(result.changeset.errors.base?.[0]?.code).toBe('stale');
      expect(rows).toHaveLength(1);
    });
  });

  describe('afterWrite', () => {
    it('runs after each write with the row, the changeset and the context', async () => {
      const { customers, audits } = setup();
      const ctx = { log: [] as string[] };
      await customers.insert(() => change<Customer>(null, { name: 'Cy' }), ctx);
      await customers.update(1, (row) => change(row, { name: 'Bea' }), ctx);
      await customers.delete(1, (row) => Changeset.of(row), ctx);
      expect(ctx.log).toEqual(['insert', 'update', 'delete']);
      expect(audits[1]).toEqual({ action: 'update', id: 1, diff: { name: { from: 'Ada', to: 'Bea' } } });
    });

    it('does not run for a failed write or a no-op update', async () => {
      const { customers } = setup();
      const ctx = { log: [] as string[] };
      await customers.update(1, (row) => change(row, { name: 'Ada' }), ctx);
      await customers.update(1, (row) => change(row, { name: 'x' }).addError('name', 'bad'), ctx);
      expect(ctx.log).toEqual([]);
    });

    it('propagates its error, so the caller’s transaction can roll back', async () => {
      const failing = repo<Customer, Partial<Customer>, number, null>({
        adapter: () => memoryAdapter<Customer>({ rows: [stored()], defaults: (d) => ({ ...stored(), ...d }) }),
        find: (id) => ({ id }),
        afterWrite: () => {
          throw new Error('audit failed');
        }
      });
      await expect(failing.update(1, (row) => change(row, { name: 'x' }), null)).rejects.toThrow('audit failed');
    });
  });

  describe('delete', () => {
    it('deletes the row and returns it as it was', async () => {
      const { customers, rows } = setup();
      const result = await customers.delete(1, (row) => Changeset.of(row), { log: [] });
      expect(unwrap(result)).toEqual(stored());
      expect(rows).toHaveLength(0);
    });

    it('refuses when the changeset’s checks fail', async () => {
      const { customers, rows } = setup();
      const result = await customers.delete(
        1,
        (row) => Changeset.of(row).check('base', (cs) => (cs.data?.status === 'closed' ? null : 'close it first'), 'restrict'),
        { log: [] }
      );
      expect(result.changeset.errors.base?.[0]).toEqual({ message: 'close it first', code: 'restrict' });
      expect(rows).toHaveLength(1);
    });

    it('turns a declared foreign-key violation into a field error', async () => {
      const orders = [{ id: 1, customerId: 1 }];
      const customers = repo<Customer, Partial<Customer>, number, null>({
        adapter: () =>
          memoryAdapter<Customer>({
            rows: [stored()],
            defaults: (d) => ({ ...stored(), ...d }),
            referencedBy: [{ name: 'orders_customer_id_fkey', rows: () => orders, columns: ['customerId'] }]
          }),
        find: (id) => ({ id })
      });
      const result = await customers.delete(
        1,
        (row) => Changeset.of(row).foreignKeyConstraint('id', 'orders_customer_id_fkey', { message: 'still has orders' }),
        null
      );
      expect(result.changeset.errors).toEqual({ id: [{ message: 'still has orders', code: 'foreign_key' }] });
    });

    it('authorizes as delete, throws not found, and rejects a changeset with changes', async () => {
      const seen: Action[] = [];
      const rows = [stored()];
      const customers = repo<Customer, Partial<Customer>, number, null>({
        adapter: () => memoryAdapter<Customer>({ rows, defaults: (d) => ({ ...stored(), ...d }) }),
        find: (id) => ({ id }),
        authorize: (action) => {
          seen.push(action);
        }
      });
      await expect(customers.delete(2, (row) => Changeset.of(row), null)).rejects.toThrow(NotFoundError);
      await expect(customers.delete(1, (row) => change(row, { name: 'x' }), null)).rejects.toThrow(/may not change/);
      expect(seen).toEqual(['delete', 'delete']);
      expect(rows).toHaveLength(1);
    });
  });
});
