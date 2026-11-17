import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Changeset, type Fields } from '../src/index.js';

interface User {
  id: number;
  email: string;
  nickname: string | null;
  age: number;
}

const zodFields = {
  email: z.string().trim().toLowerCase().email('is not an email'),
  nickname: z.string().nullable(),
  age: z.coerce.number().int().min(13, 'is too young')
} satisfies Fields<User>;

const valibotFields = {
  email: v.pipe(v.string(), v.trim(), v.toLowerCase(), v.email('is not an email')),
  nickname: v.nullable(v.string()),
  age: v.pipe(v.unknown(), v.transform(Number), v.number(), v.integer(), v.minValue(13, 'is too young'))
} satisfies Fields<User>;

const stored: User = { id: 1, email: 'a@example.com', nickname: 'al', age: 30 };

describe.each([
  ['zod', zodFields],
  ['valibot', valibotFields]
] as const)('a changeset built with %s', (_vendor, fields) => {
  const build = (attrs: unknown) =>
    Changeset.of(stored).cast(attrs, fields as Fields<User>, ['email', 'nickname', 'age']).validateRequired(['email']);

  it('parses and normalizes, and drops no-op values', () => {
    const changeset = build({ email: '  A@Example.com ', nickname: '', age: '31' });
    expect(changeset.changes).toEqual({ nickname: null, age: 31 });
    expect(changeset.valid).toBe(true);
  });

  it('reports schema messages and blanks the same way', () => {
    const changeset = build({ email: '', age: '5' });
    expect(changeset.errors).toEqual({
      email: [{ message: "can't be blank", code: 'required' }],
      age: [{ message: 'is too young', code: 'invalid' }]
    });
    expect(build({ email: 'nope' }).errors.email).toEqual([{ message: 'is not an email', code: 'invalid' }]);
  });
});
