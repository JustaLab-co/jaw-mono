throw new Error(
  '@jaw.id/core/internal is ESM-only. The CJS build is one bundle per entry point, so a CJS copy of this one would carry its own store and the values set through it would never reach a request.'
);
