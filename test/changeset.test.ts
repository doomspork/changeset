import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Changeset, cast, change, errorMessages, sameValue } from '../src/index.js';
import { fields, type Project, STATUS_FLOW, stored } from './fixtures.js';

const insert = (attrs: unknown, permitted: readonly (keyof typeof fields)[] = ['name', 'slug']) =>
  Changeset.of<Project>(null).cast(attrs, fields, permitted);

describe('cast', () => {
  it('ignores keys that are not permitted', () => {
    const changeset = cast(stored(), { name: 'Zeus', ownerId: 'u2', id: 'evil', status: 'active' }, fields, ['name']);
    expect(changeset.changes).toEqual({ name: 'Zeus' });
    expect(changeset.valid).toBe(true);
  });

  it('turns blank text into null', () => {
    const changeset = cast(stored({ description: 'old' }), { description: '   ' }, fields, ['description']);
    expect(changeset.changes).toEqual({ description: null });
  });

  it("reports blank into a non-null column as can't be blank", () => {
    const changeset = cast(stored(), { name: '  ' }, fields, ['name']);
    expect(changeset.errors).toEqual({ name: [{ message: "can't be blank", code: 'required' }] });
    expect(changeset.changes).toEqual({});
  });

  it('does not count a value equal to the stored one as a change', () => {
    const changeset = cast(
      stored(),
      {
        name: ' Apollo ',
        slug: 'APOLLO',
        tags: ['x'],
        dueAt: '2026-01-01T00:00:00.000Z',
        settings: { notify: true, theme: 'dark' },
        priority: '1'
      },
      fields,
      ['name', 'slug', 'tags', 'dueAt', 'settings', 'priority']
    );
    expect(changeset.changes).toEqual({});
    expect(changeset.changed).toBe(false);
  });

  it('leaves an omitted key alone, and treats undefined as omitted', () => {
    const changeset = cast(stored(), { name: 'Zeus', slug: undefined }, fields, ['name', 'slug', 'description']);
    expect(Object.keys(changeset.changes)).toEqual(['name']);
  });

  it('parses each value with its schema', () => {
    const changeset = insert({ name: '  Zeus ', slug: ' ZEUS ' });
    expect(changeset.changes).toEqual({ name: 'Zeus', slug: 'zeus' });
    expect(insert({ priority: '7' }, ['priority']).changes).toEqual({ priority: 7 });
  });

  it('reports a parse failure as invalid, with the schema message', () => {
    const changeset = insert({ name: 'ok', slug: 'not a slug' });
    expect(changeset.errors).toEqual({ slug: [{ message: 'has invalid format', code: 'invalid' }] });
  });

  it('collects every field error at once', () => {
    const changeset = insert({ name: '', slug: '!!' });
    expect(Object.keys(changeset.errors).sort()).toEqual(['name', 'slug']);
  });

  it('counts every value on an insert as a change', () => {
    expect(insert({ name: 'Apollo', slug: 'apollo' }).changes).toEqual({ name: 'Apollo', slug: 'apollo' });
  });

  it('rejects attributes that are not an object', () => {
    for (const attrs of [null, 'x', 3, ['name']]) {
      expect(insert(attrs).errors).toEqual({ base: [{ message: 'expected an object of attributes', code: 'invalid' }] });
    }
  });

  it('throws on a permitted key with no schema', () => {
    const loose = fields as Record<string, unknown>;
    expect(() => cast(stored(), { ownerId: 'u2' }, loose as typeof fields, ['ownerId' as 'name'])).toThrow(/No field schema/);
  });

  it('throws on an asynchronous schema', () => {
    const asyncFields = { name: z.string().refine(async () => true) };
    expect(() => cast(stored(), { name: 'x' }, asyncFields, ['name'])).toThrow(/synchronous/);
  });

  it('keeps the raw attributes as params', () => {
    expect(insert({ name: 'A', slug: 'a', extra: 1 }).params).toEqual({ name: 'A', slug: 'a', extra: 1 });
  });

  it('chains: a later cast adds to an earlier one', () => {
    const changeset = insert({ name: 'A' }, ['name']).cast({ slug: 'b' }, fields, ['slug']);
    expect(changeset.changes).toEqual({ name: 'A', slug: 'b' });
  });
});

describe('trusted changes', () => {
  it('change and putChange skip parsing and drop no-op values', () => {
    const changeset = change(stored(), { status: 'archived', name: 'Apollo' });
    expect(changeset.changes).toEqual({ status: 'archived' });
    expect(changeset.putChange('status', 'draft').changes).toEqual({});
  });

  it('updateChange rewrites only an existing change', () => {
    const changeset = change(stored(), { name: 'zeus' });
    expect(changeset.updateChange('name', (n) => n.toUpperCase()).changes).toEqual({ name: 'ZEUS' });
    expect(changeset.updateChange('slug', () => 'never').changes).toEqual({ name: 'zeus' });
  });

  it('deleteChange drops a change', () => {
    expect(change(stored(), { name: 'zeus' }).deleteChange('name').changes).toEqual({});
  });

  it('is immutable', () => {
    const base = Changeset.of(stored());
    base.putChange('name', 'x').addError('name', 'bad');
    expect(base.changes).toEqual({});
    expect(base.errors).toEqual({});
  });

  it('reads fields, changes, action and diff', () => {
    const changeset = change(stored(), { name: 'Zeus' });
    expect(changeset.action).toBe('update');
    expect(Changeset.of<Project>(null).action).toBe('insert');
    expect(changeset.getField('name')).toBe('Zeus');
    expect(changeset.getField('slug')).toBe('apollo');
    expect(changeset.getChange('slug')).toBeUndefined();
    expect(changeset.diff()).toEqual({ name: { from: 'Apollo', to: 'Zeus' } });
    expect(change<Project>(null, { name: 'New' }).diff()).toEqual({ name: { from: undefined, to: 'New' } });
  });
});

describe('validators', () => {
  it('validateRequired checks the resulting value, changed or not', () => {
    expect(insert({ name: 'A' }, ['name']).validateRequired(['name', 'slug']).errors).toEqual({
      slug: [{ message: "can't be blank", code: 'required' }]
    });
    expect(Changeset.of(stored()).validateRequired(['name', 'slug']).valid).toBe(true);
    expect(change(stored(), { name: ' ' }).validateRequired(['name'], { message: 'needed' }).errors.name).toEqual([
      { message: 'needed', code: 'required' }
    ]);
  });

  it('validateRequired skips a column that already has an error', () => {
    const changeset = insert({ name: '' }, ['name']).validateRequired(['name']);
    expect(changeset.errors.name).toHaveLength(1);
  });

  it('validateChange runs only on a change without an error', () => {
    let calls = 0;
    const check = () => {
      calls++;
      return 'nope';
    };
    Changeset.of(stored()).validateChange('name', check);
    insert({ name: '' }, ['name']).validateChange('name', check);
    expect(calls).toBe(0);
    const changeset = change(stored(), { name: 'Zeus' }).validateChange('name', check, 'custom');
    expect(changeset.errors.name).toEqual([{ message: 'nope', code: 'custom' }]);
    expect(change(stored(), { name: 'Zeus' }).validateChange('name', () => null).valid).toBe(true);
  });

  it('validateInclusion and validateExclusion', () => {
    expect(change(stored(), { slug: 'admin' }).validateExclusion('slug', ['admin', 'api']).errors.slug).toEqual([
      { message: 'is reserved', code: 'exclusion' }
    ]);
    expect(change(stored(), { slug: 'zeus' }).validateExclusion('slug', ['admin']).valid).toBe(true);
    expect(change(stored(), { priority: 9 }).validateInclusion('priority', [1, 2, 3]).errors.priority).toEqual([
      { message: 'is invalid', code: 'inclusion' }
    ]);
    expect(change(stored(), { priority: 2 }).validateInclusion('priority', [1, 2, 3]).valid).toBe(true);
  });

  it('validateFormat', () => {
    expect(change(stored(), { slug: 'Bad Slug' }).validateFormat('slug', /^[a-z-]+$/).errors.slug).toEqual([
      { message: 'has invalid format', code: 'format' }
    ]);
    expect(change(stored(), { slug: 'good' }).validateFormat('slug', /^[a-z-]+$/g).validateFormat('slug', /^[a-z-]+$/g).valid).toBe(true);
    expect(change(stored({ description: 'x' }), { description: null }).validateFormat('description', /x/).valid).toBe(true);
  });

  it('validateLength counts characters, and arrays', () => {
    const named = (name: string) => change(stored(), { name });
    expect(named('ab').validateLength('name', { min: 3 }).errors.name).toEqual([{ message: 'should be at least 3 long', code: 'length' }]);
    expect(named('abcd').validateLength('name', { max: 3 }).errors.name?.[0]?.message).toBe('should be at most 3 long');
    expect(named('ab').validateLength('name', { is: 3 }).errors.name?.[0]?.message).toBe('should be 3 long');
    expect(named('😀😀😀').validateLength('name', { max: 3 }).valid).toBe(true);
    expect(change(stored(), { tags: ['a', 'b', 'c'] }).validateLength('tags', { max: 2, message: 'too many' }).errors.tags).toEqual([
      { message: 'too many', code: 'length' }
    ]);
  });

  it('validateNumber', () => {
    const p = (priority: number) => change(stored(), { priority });
    expect(p(0).validateNumber('priority', { gt: 0 }).errors.priority?.[0]).toEqual({ message: 'should be greater than 0', code: 'number' });
    expect(p(0).validateNumber('priority', { gte: 1 }).errors.priority?.[0]?.message).toBe('should be at least 1');
    expect(p(5).validateNumber('priority', { lt: 5 }).errors.priority?.[0]?.message).toBe('should be less than 5');
    expect(p(6).validateNumber('priority', { lte: 5 }).errors.priority?.[0]?.message).toBe('should be at most 5');
    expect(p(3).validateNumber('priority', { gte: 1, lte: 5 }).valid).toBe(true);
  });

  it('validateTransition on update follows the flow', () => {
    const move = (from: Project['status'], to: Project['status']) =>
      change(stored({ status: from }), { status: to }).validateTransition('status', STATUS_FLOW);
    expect(move('draft', 'active').valid).toBe(true);
    expect(move('archived', 'active').valid).toBe(true);
    expect(move('active', 'draft').errors.status).toEqual([{ message: "can't change from active to draft", code: 'transition' }]);
  });

  it('validateTransition on insert allows any state the flow has a key for', () => {
    const start = (status: Project['status'], flow: Partial<Record<Project['status'], readonly Project['status'][]>>) =>
      change<Project>(null, { status }).validateTransition('status', flow);
    expect(start('draft', STATUS_FLOW).valid).toBe(true);
    expect(start('active', { draft: ['active'] }).errors.status).toEqual([{ message: "can't start as active", code: 'transition' }]);
  });

  it('validators accumulate across columns', () => {
    const changeset = change(stored(), { name: 'a', slug: 'admin' })
      .validateLength('name', { min: 2 })
      .validateExclusion('slug', ['admin'])
      .addError('base', 'nope');
    expect(errorMessages(changeset)).toEqual(['name should be at least 2 long', 'slug is reserved', 'nope']);
  });
});

describe('constraints', () => {
  const declared = change(stored(), { slug: 'taken', ownerId: 'ghost' })
    .uniqueConstraint('slug', ['accountId', 'slug'])
    .uniqueConstraint('name', 'project_name_key', { message: 'is in use' })
    .foreignKeyConstraint('ownerId')
    .checkConstraint('priority', 'priority_range');

  it('maps a unique violation by its exact columns, in any order', () => {
    expect(declared.withViolation({ kind: 'unique', columns: ['slug', 'accountId'] })?.errors).toEqual({
      slug: [{ message: 'has already been taken', code: 'unique' }]
    });
  });

  it('does not map a unique violation on a subset or superset of the columns', () => {
    expect(declared.withViolation({ kind: 'unique', columns: ['slug'] })).toBeNull();
    expect(declared.withViolation({ kind: 'unique', columns: ['accountId', 'slug', 'name'] })).toBeNull();
  });

  it('maps by constraint name', () => {
    expect(declared.withViolation({ kind: 'unique', constraint: 'project_name_key' })?.errors).toEqual({
      name: [{ message: 'is in use', code: 'unique' }]
    });
  });

  it('maps a foreign key by its column, and a check by name', () => {
    expect(declared.withViolation({ kind: 'foreign_key', columns: ['ownerId'] })?.errors.ownerId?.[0]).toEqual({
      message: 'does not exist',
      code: 'foreign_key'
    });
    expect(declared.withViolation({ kind: 'check', constraint: 'priority_range' })?.errors.priority?.[0]?.code).toBe('check');
  });

  it('returns null for an undeclared violation or a different kind', () => {
    expect(declared.withViolation({ kind: 'check', constraint: 'other' })).toBeNull();
    expect(declared.withViolation({ kind: 'foreign_key', columns: ['accountId', 'slug'] })).toBeNull();
    expect(Changeset.of(stored()).withViolation({ kind: 'unique', columns: ['slug'] })).toBeNull();
  });
});

describe('sameValue', () => {
  it('compares column values structurally', () => {
    expect(sameValue(new Date(1), new Date(1))).toBe(true);
    expect(sameValue(new Date(1), new Date(2))).toBe(false);
    expect(sameValue({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(sameValue({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(sameValue([1], { 0: 1 })).toBe(false);
    expect(sameValue(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(sameValue(10n, 10n)).toBe(true);
    expect(sameValue(NaN, NaN)).toBe(true);
    expect(sameValue(null, undefined)).toBe(false);
    class Decimal {
      constructor(private readonly v: string) {}
      valueOf() {
        return this.v;
      }
    }
    expect(sameValue(new Decimal('1.50'), new Decimal('1.50'))).toBe(true);
    expect(sameValue(new Decimal('1.50'), new Decimal('1.5'))).toBe(false);
  });
});
