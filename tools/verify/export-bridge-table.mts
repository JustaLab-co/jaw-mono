import { BRIDGE_CHAINS } from '../../packages/ui/src/utils/bridgeCalls/contracts.ts';

process.stdout.write(JSON.stringify({ schema: 1, version: 1, chains: BRIDGE_CHAINS }, null, 2) + '\n');
