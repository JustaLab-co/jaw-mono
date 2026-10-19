import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cn } from './utils';

// The config is CommonJS inside a "type": "module" package — Tailwind loads it with its own
// loader, so it can't be imported here. Evaluating the source in a CJS shim reads the real keys
// rather than a copy of them, which is the whole point of the checks below.
function loadTailwindConfig() {
  const path = fileURLToPath(new URL('../../tailwind.config.js', import.meta.url));
  const src = readFileSync(path, 'utf8');
  const module = { exports: {} as Record<string, any> };
  new Function('module', 'exports', 'require', src)(module, module.exports, () => ({}));
  return module.exports;
}

const FONT_SIZE_KEYS = Object.keys(loadTailwindConfig().theme.extend.fontSize);

describe('cn — custom type roles', () => {
  // Tailwind emits `.text-sm` *after* our custom fontSize keys, so a class that survives the merge
  // alongside a base `text-sm` loses on source order. Every role must therefore *replace* it.
  it.each(FONT_SIZE_KEYS)('text-%s replaces a base text-sm', (role) => {
    expect(cn('text-sm', `text-${role}`)).toBe(`text-${role}`);
  });

  it.each(FONT_SIZE_KEYS)('text-%s is replaced by a later text-sm', (role) => {
    expect(cn(`text-${role}`, 'text-sm')).toBe('text-sm');
  });

  it('leaves text colors alone — they are a different class group', () => {
    expect(cn('text-muted-foreground', 'text-body')).toBe('text-muted-foreground text-body');
    expect(cn('text-body', 'text-destructive')).toBe('text-body text-destructive');
  });

  it('still resolves Tailwind’s own conflicts', () => {
    expect(cn('px-2', 'px-6')).toBe('px-6');
    expect(cn('text-sm', 'text-[13px]')).toBe('text-[13px]');
  });

  it('keeps the roles list in step with the config', () => {
    // A token added to tailwind.config.js but not to FONT_SIZE_ROLES would silently stop
    // overriding component base sizes; the per-role cases above are what actually catch it.
    expect(FONT_SIZE_KEYS.length).toBeGreaterThan(0);
  });
});
