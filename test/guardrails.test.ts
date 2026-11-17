import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const src = join(root, 'src');

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith('.ts') ? [join(dir, entry.name)] : []
  );

/** Every import and re-export in a file, with whether it is type-only. */
const imports = (file: string) =>
  [...readFileSync(file, 'utf8').matchAll(/^\s*(import|export)\s+(type\s+)?(?:[^'";]*?\sfrom\s*)?['"]([^'"]+)['"]|\bimport\s*\(\s*()['"]([^'"]+)['"]/gm)].map(
    ([, , typeOnly, specifier, , dynamic]) => ({ specifier: (specifier ?? dynamic)!, typeOnly: Boolean(typeOnly) })
  );

const isCore = (file: string) => !relative(src, file).includes('/');

describe('guardrails', () => {
  it('nothing under src/ imports a package at runtime', () => {
    const offenders = files(src).flatMap((file) =>
      imports(file)
        .filter(({ specifier, typeOnly }) => !specifier.startsWith('.') && !typeOnly)
        .map(({ specifier }) => `${relative(root, file)} -> ${specifier}`)
    );
    expect(offenders).toEqual([]);
  });

  it('the core imports no adapter', () => {
    const offenders = files(src)
      .filter(isCore)
      .flatMap((file) =>
        imports(file)
          .filter(({ specifier }) => !specifier.startsWith('./') || specifier.split('/').length > 2)
          .map(({ specifier }) => `${relative(root, file)} -> ${specifier}`)
      );
    expect(offenders).toEqual([]);
  });

  it('package.json has no runtime dependencies', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(pkg.dependencies ?? {}).toEqual({});
  });
});
