const sortedKeys = (_: string, value: unknown) =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)))
    : value;

export const canonical = (value: unknown) => JSON.stringify(value, sortedKeys);
