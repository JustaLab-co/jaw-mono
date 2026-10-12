import { describe, expect, it } from 'vitest';
import { reconcileSeconds } from './instrumentation-node';

describe('reconcileSeconds', () => {
  it('reconciles every minute unless set, and not at all on 0', () => {
    expect(reconcileSeconds(undefined)).toBe(60);
    expect(reconcileSeconds('')).toBe(60);
    expect(reconcileSeconds('30')).toBe(30);
    expect(reconcileSeconds('0')).toBe(0);
  });
});
