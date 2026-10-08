import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'base-command': 'src/base-command.ts',
    // lib
    'lib/ws-bridge': 'src/lib/ws-bridge.ts',
    'lib/bridge-singleton': 'src/lib/bridge-singleton.ts',
    'lib/crypto': 'src/lib/crypto.ts',
    'lib/config': 'src/lib/config.ts',
    'lib/output': 'src/lib/output.ts',
    'lib/paths': 'src/lib/paths.ts',
    'lib/types': 'src/lib/types.ts',
    'lib/validation': 'src/lib/validation.ts',
    'lib/payment-lock': 'src/lib/payment-lock.ts',
    // session lib
    'lib/keystore': 'src/lib/keystore.ts',
    'lib/session-config': 'src/lib/session-config.ts',
    'lib/session-bridge': 'src/lib/session-bridge.ts',
    // commands
    'commands/version': 'src/commands/version.ts',
    'commands/disconnect': 'src/commands/disconnect.ts',
    'commands/config/set': 'src/commands/config/set.ts',
    'commands/config/show': 'src/commands/config/show.ts',
    'commands/config/write': 'src/commands/config/write.ts',
    'commands/mcp/index': 'src/commands/mcp/index.ts',
    'commands/rpc/call': 'src/commands/rpc/call.ts',
    // Commands are the one thing that needs an entry each: oclif loads them
    // from dist by path at runtime, so a command missing here compiles, tests
    // green, and does not exist in a published build.
    'commands/session/setup': 'src/commands/session/setup.ts',
    'commands/session/add': 'src/commands/session/add.ts',
    'commands/session/status': 'src/commands/session/status.ts',
    'commands/session/revoke': 'src/commands/session/revoke.ts',
    'commands/x402/status': 'src/commands/x402/status.ts',
    'commands/x402/pay': 'src/commands/x402/pay.ts',
    'commands/x402/log': 'src/commands/x402/log.ts',
    // mcp
    'mcp/server': 'src/mcp/server.ts',
    'mcp/handlers/rpc': 'src/mcp/handlers/rpc.ts',
    'mcp/handlers/config': 'src/mcp/handlers/config.ts',
    'mcp/handlers/daemon': 'src/mcp/handlers/daemon.ts',
    'mcp/handlers/resources': 'src/mcp/handlers/resources.ts',
  },
  format: ['esm'],
  outDir: 'dist',
  dts: false,
  splitting: false,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: 'node20',
  // Private workspace package, so it ships inside the CLI bundle. Bundled from
  // source, so a stale or half-cleaned agent dist never ends up in the CLI.
  noExternal: ['@jaw.id/agent'],
  esbuildOptions(options) {
    options.conditions = [...(options.conditions ?? []), '@jaw-mono/source'];
  },
  external: [
    '@jaw.id/core',
    '@modelcontextprotocol/sdk',
    '@modelcontextprotocol/sdk/server/mcp.js',
    '@modelcontextprotocol/sdk/server/stdio.js',
    '@oclif/core',
    'open',
    'viem',
    'viem/accounts',
    'ws',
    'zod',
  ],
});
