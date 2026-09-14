import { Command, Flags } from '@oclif/core';
import type { OutputFormat } from './lib/types.js';
import { loadConfig } from './lib/config.js';
import { formatOutput } from './lib/output.js';

export abstract class BaseCommand extends Command {
  static override baseFlags = {
    output: Flags.string({
      char: 'o',
      description: 'Output format',
      options: ['json', 'human'],
      default: 'human',
      env: 'JAW_OUTPUT',
    }),
    chain: Flags.integer({
      char: 'c',
      description: 'Chain ID',
      env: 'JAW_CHAIN_ID',
    }),
    'api-key': Flags.string({
      description: 'JAW API key',
      env: 'JAW_API_KEY',
    }),
    yes: Flags.boolean({
      char: 'y',
      description: 'Skip confirmations (for AI agents)',
      default: false,
    }),
    quiet: Flags.boolean({
      char: 'q',
      description: 'Suppress non-essential output',
      default: false,
    }),
  };

  /**
   * The api key to operate under, or undefined when there is none yet.
   *
   * It resolves rather than requires, because a command that opens the browser
   * no longer needs one up front: the bridge fills one in and the CLI keeps it.
   * A command that signs locally has nobody to fill it in and refuses for
   * itself, which is the only place that knows what the absence costs it.
   */
  protected resolveApiKey(flags: { 'api-key'?: string }): string | undefined {
    const config = loadConfig();
    return flags['api-key'] ?? config.apiKey ?? config.workspaceApiKey;
  }

  protected resolveChainId(flags: { chain?: number }): number {
    const chainId = flags.chain ?? loadConfig().defaultChain;
    if (!chainId) {
      this.error('Chain ID required. Set via --chain, JAW_CHAIN_ID env, or `jaw config set defaultChain <id>`');
    }
    return chainId;
  }

  protected outputResult(data: unknown, format: OutputFormat): void {
    const output = formatOutput(data, format);
    this.log(output);
  }
}
