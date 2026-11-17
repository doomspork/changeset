import { Changeset, type ConstraintViolation, sameValue } from '../changeset.js';
import { type Adapter, repo } from '../repo.js';

// The adapter contract as a test suite. An adapter runs it over a small table it sets up itself; the
// suite takes the test runner's `describe`, `it` and `beforeEach`, so it works with any runner that has
// them (vitest, jest, mocha, node:test) and depends on none.

/**
 * The contract table's row. The adapter's table must have these columns, by these names as the adapter
 * reports them, and may have more:
 *
 * - `id`: a string primary key the table generates;
 * - `sku`: unique;
 * - `name`: required text;
 * - `qty`: an integer, default 0, with a check constraint that it is at least 0;
 * - `parentId`: nullable, a foreign key to the same table's `id` that restricts deletes.
 */
export interface ContractItem {
  id: string;
  sku: string;
  name: string;
  qty: number;
  parentId: string | null;
}

export interface ContractHarness<Where> {
  /** An adapter over the contract table. Called for every test. */
  adapter(): Adapter<ContractItem, Where> | Promise<Adapter<ContractItem, Where>>;
  /** Empties the table. Runs before every test. */
  reset(): void | Promise<void>;
  /** A `where` matching rows whose columns equal every value given: `{ id }`, or `{ id, sku }`. */
  where(values: Partial<ContractItem> & Pick<ContractItem, 'id'>): Where;
  /** The table's constraint names, as the database reports them. */
  constraints: {
    unique: string;
    foreignKey: string;
    /** Leave out when the adapter can't report check violations; the check tests are skipped. */
    check?: string;
  };
}

/** The test functions the suite registers its tests with. */
export interface TestRunner {
  describe(name: string, body: () => void): unknown;
  it(name: string, body: () => Promise<void>): unknown;
  beforeEach(body: () => Promise<void>): unknown;
}

class ContractFailure extends Error {
  override name = 'ContractFailure';
}

const show = (value: unknown) =>
  JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v)) ?? String(value);

function equal(actual: unknown, expected: unknown, what: string): void {
  if (!sameValue(actual, expected)) throw new ContractFailure(`${what}: expected ${show(expected)}, got ${show(actual)}`);
}

function ok(condition: unknown, what: string): asserts condition {
  if (!condition) throw new ContractFailure(what);
}

async function rejection(run: () => Promise<unknown>, what: string): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new ContractFailure(`${what}: expected an error, got none`);
}

const pick = (row: ContractItem | null) => row && { sku: row.sku, name: row.name, qty: row.qty, parentId: row.parentId };

/**
 * Registers the adapter contract's tests: `adapterContract('my adapter', harness, { describe, it, beforeEach })`.
 */
export function adapterContract<Where>(name: string, harness: ContractHarness<Where>, runner: TestRunner): void {
  const { describe, it, beforeEach } = runner;
  let adapter: Adapter<ContractItem, Where>;
  const insert = (data: Partial<ContractItem>) => adapter.insert({ name: 'Item', ...data });
  const byId = (row: { id: string }) => harness.where({ id: row.id });

  /** The violation `error` normalizes to, which must be of `kind` and name `constraint` or `columns`. */
  const expectViolation = (error: unknown, kind: ConstraintViolation['kind'], constraint: string, columns: string[]) => {
    const violation = adapter.violation(error);
    ok(violation, `violation() returned null for a ${kind} failure: ${String(error)}`);
    equal(violation.kind, kind, 'violation kind');
    const byName = violation.constraint === constraint;
    const byColumns = violation.columns !== undefined && sameValue([...violation.columns].sort(), [...columns].sort());
    ok(byName || byColumns, `violation must name ${constraint} or columns ${show(columns)}, got ${show(violation)}`);
    if (violation.columns !== undefined) equal([...violation.columns].sort(), [...columns].sort(), 'violation columns, as field names');
    return violation;
  };

  describe(`adapter contract: ${name}`, () => {
    beforeEach(async () => {
      await harness.reset();
      adapter = await harness.adapter();
    });

    describe('insert', () => {
      it('returns the row as stored, with generated and default columns', async () => {
        const row = await insert({ sku: 'a', name: 'Anvil' });
        ok(typeof row.id === 'string' && row.id.length > 0, 'a generated string id');
        equal(pick(row), { sku: 'a', name: 'Anvil', qty: 0, parentId: null }, 'inserted row');
      });

      it('returns a fresh object', async () => {
        const row = await insert({ sku: 'a' });
        row.name = 'mutated';
        equal((await adapter.findOne(byId(row)))?.name, 'Item', 'stored name after mutating the returned row');
      });
    });

    describe('findOne', () => {
      it('finds the one matching row, or null', async () => {
        const row = await insert({ sku: 'a' });
        await insert({ sku: 'b' });
        equal(pick(await adapter.findOne(byId(row))), pick(row), 'found row');
        equal(await adapter.findOne(harness.where({ id: '00000000-0000-0000-0000-000000000000' })), null, 'missing row');
      });

      it('applies every column in the where', async () => {
        const row = await insert({ sku: 'a' });
        equal((await adapter.findOne(harness.where({ id: row.id, sku: 'a' })))?.id, row.id, 'row matching both columns');
        equal(await adapter.findOne(harness.where({ id: row.id, sku: 'other' })), null, 'row excluded by the second column');
      });

      it('returns a fresh object each time', async () => {
        const row = await insert({ sku: 'a' });
        const first = await adapter.findOne(byId(row));
        ok(first, 'found');
        first.name = 'mutated';
        equal((await adapter.findOne(byId(row)))?.name, 'Item', 'name after mutating an earlier read');
      });
    });

    describe('update', () => {
      it('writes only the given columns and returns the row as stored', async () => {
        const row = await insert({ sku: 'a', qty: 3 });
        const updated = await adapter.update(byId(row), { name: 'Renamed' });
        equal(pick(updated), { sku: 'a', name: 'Renamed', qty: 3, parentId: null }, 'updated row');
        equal(pick(await adapter.findOne(byId(row))), pick(updated), 'stored row');
      });

      it('returns null, and writes nothing, when no row matches', async () => {
        const row = await insert({ sku: 'a' });
        equal(await adapter.update(harness.where({ id: row.id, sku: 'other' }), { name: 'x' }), null, 'update of an excluded row');
        equal(await adapter.update(harness.where({ id: '00000000-0000-0000-0000-000000000000' }), { name: 'x' }), null, 'update of a missing row');
        equal((await adapter.findOne(byId(row)))?.name, 'Item', 'stored name');
      });

      it('does not change a row read earlier', async () => {
        const row = await insert({ sku: 'a' });
        const read = await adapter.findOne(byId(row));
        await adapter.update(byId(row), { name: 'Renamed' });
        equal(read?.name, 'Item', 'name on the earlier read');
      });
    });

    describe('remove', () => {
      it('deletes the matching row and returns it', async () => {
        const row = await insert({ sku: 'a' });
        equal(pick(await adapter.remove(byId(row))), pick(row), 'removed row');
        equal(await adapter.findOne(byId(row)), null, 'row after remove');
      });

      it('returns null, and deletes nothing, when no row matches', async () => {
        const row = await insert({ sku: 'a' });
        equal(await adapter.remove(harness.where({ id: row.id, sku: 'other' })), null, 'remove of an excluded row');
        equal((await adapter.findOne(byId(row)))?.id, row.id, 'row still stored');
      });
    });

    describe('narrow', () => {
      it('adds column values to a where', async () => {
        const row = await insert({ sku: 'a', qty: 2 });
        equal((await adapter.findOne(adapter.narrow(byId(row), { qty: 2 })))?.id, row.id, 'read with the current value');
        equal(await adapter.findOne(adapter.narrow(byId(row), { qty: 1 })), null, 'read with a stale value');
      });

      it('makes a write with a stale value miss', async () => {
        const row = await insert({ sku: 'a', qty: 2 });
        equal(await adapter.update(adapter.narrow(byId(row), { qty: 1 }), { name: 'x' }), null, 'update with a stale value');
        equal(await adapter.remove(adapter.narrow(byId(row), { qty: 1 })), null, 'remove with a stale value');
        equal((await adapter.update(adapter.narrow(byId(row), { qty: 2 }), { name: 'x' }))?.name, 'x', 'update with the current value');
      });

      it('keeps the where’s own columns', async () => {
        const row = await insert({ sku: 'a', qty: 2 });
        equal(await adapter.findOne(adapter.narrow(harness.where({ id: row.id, sku: 'other' }), { qty: 2 })), null, 'excluded row');
      });
    });

    describe('violation', () => {
      it('reports a unique violation on insert and on update', async () => {
        await insert({ sku: 'a' });
        const other = await insert({ sku: 'b' });
        const columns = ['sku'];
        expectViolation(await rejection(() => insert({ sku: 'a' }), 'duplicate insert'), 'unique', harness.constraints.unique, columns);
        expectViolation(await rejection(() => adapter.update(byId(other), { sku: 'a' }), 'duplicate update'), 'unique', harness.constraints.unique, columns);
      });

      it('reports a foreign-key violation on insert, and on removing a referenced row', async () => {
        const fk = harness.constraints.foreignKey;
        const missing = await rejection(() => insert({ sku: 'a', parentId: '00000000-0000-0000-0000-000000000000' }), 'insert with a missing parent');
        expectViolation(missing, 'foreign_key', fk, ['parentId']);
        const parent = await insert({ sku: 'p' });
        await insert({ sku: 'c', parentId: parent.id });
        const restricted = expectViolation(await rejection(() => adapter.remove(byId(parent)), 'remove of a referenced row'), 'foreign_key', fk, ['parentId']);
        equal(restricted.constraint, fk, 'a restricted delete names its constraint');
        equal((await adapter.findOne(byId(parent)))?.id, parent.id, 'referenced row still stored');
      });

      it('reports a check violation', async () => {
        const check = harness.constraints.check;
        if (check === undefined) return;
        expectViolation(await rejection(() => insert({ sku: 'a', qty: -1 }), 'insert failing the check'), 'check', check, ['qty']);
      });

      it('returns null for anything else', async () => {
        for (const error of [new Error('connection lost'), null, undefined, 'unique', 42, {}]) {
          equal(adapter.violation(error), null, `violation(${show(error)})`);
        }
      });

      it('leaves the table as it was after a violation', async () => {
        await insert({ sku: 'a' });
        await rejection(() => insert({ sku: 'a' }), 'duplicate insert');
        const b = await insert({ sku: 'b' });
        await rejection(() => adapter.update(byId(b), { sku: 'a' }), 'duplicate update');
        equal((await adapter.findOne(byId(b)))?.sku, 'b', 'sku after a failed update');
      });
    });

    describe('with a repo', () => {
      const items = repo<ContractItem, Where, string, null>({
        adapter: () => adapter,
        find: (id) => harness.where({ id })
      });
      const create = (sku: string) => () =>
        Changeset.of<ContractItem>(null).change({ sku, name: 'Item' }).uniqueConstraint('sku', harness.constraints.unique).uniqueConstraint('sku');

      it('turns a unique violation into a field error, declared by name or by columns', async () => {
        ok((await items.insert(create('a'), null)).ok, 'first insert');
        const result = await items.insert(create('a'), null);
        ok(!result.ok, 'duplicate insert fails');
        equal(result.changeset.errors.sku?.[0]?.code, 'unique', 'error code on sku');
      });

      it('turns a foreign-key violation into a field error', async () => {
        const result = await items.insert(
          () =>
            Changeset.of<ContractItem>(null)
              .change({ sku: 'a', name: 'Item', parentId: '00000000-0000-0000-0000-000000000000' })
              .foreignKeyConstraint('parentId', harness.constraints.foreignKey)
              .foreignKeyConstraint('parentId'),
          null
        );
        ok(!result.ok, 'insert with a missing parent fails');
        equal(result.changeset.errors.parentId?.[0]?.code, 'foreign_key', 'error code on parentId');
      });

      it('writes and reads back through update', async () => {
        const created = await items.insert(create('a'), null);
        ok(created.ok, 'insert');
        const updated = await items.update(created.row.id, (row) => Changeset.of(row).change({ qty: 5 }), null);
        ok(updated.ok, 'update');
        equal(updated.row.qty, 5, 'qty');
        equal(updated.changeset.diff(), { qty: { from: 0, to: 5 } }, 'diff');
      });
    });
  });
}
