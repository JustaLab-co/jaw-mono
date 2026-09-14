import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import { readX402Log } from '../../x402/ledger.js';
import { renderEntry, renderSummary } from '../../x402/log-view.js';
import type { OutputFormat } from '../../lib/types.js';

/**
 * What the agent bought, from the terminal.
 *
 * The ledger is the audit trail for money an agent moved without being watched,
 * so the answer to "what did it spend overnight" should not require wiring an
 * MCP client to ask.
 */
export default class X402Log extends BaseCommand {
  static override description =
    'Show the local x402 payment ledger: every attempt, paid, failed or refused, with amounts and transactions.';

  static override examples = [
    '<%= config.bin %> x402 log',
    '<%= config.bin %> x402 log --limit 20',
    '<%= config.bin %> x402 log --status failed',
    '<%= config.bin %> x402 log --output json',
  ];

  static override flags = {
    ...BaseCommand.baseFlags,
    limit: Flags.integer({ description: 'Show only the most recent N entries.' }),
    status: Flags.string({
      description: 'Show only entries with this outcome.',
      options: ['paid', 'failed', 'refused'],
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(X402Log);
    const format = flags.output as OutputFormat;

    // `slice(-0)` is `slice(0)`, so a zero limit would quietly dump the whole
    // ledger, which is the worst possible reading of "show me none". Reject it
    // rather than pick a meaning; omitting the flag is how you ask for all.
    if (flags.limit !== undefined && flags.limit < 1) {
      this.error(`--limit must be 1 or more (got ${flags.limit}). Omit it to show every entry.`);
    }

    // Filter before limiting, so `--limit 5 --status failed` means the last five
    // failures rather than the failures among the last five entries.
    let entries = readX402Log();
    // A checkpoint carries `paid` so the sums count it with no branch of their
    // own, but it is not an outcome and has no business in a list of them.
    if (flags.status) entries = entries.filter((e) => e.kind !== 'checkpoint' && e.status === flags.status);
    if (flags.limit !== undefined) entries = entries.slice(-flags.limit);

    if (format === 'json') {
      this.outputResult(entries, format);
      return;
    }

    if (entries.length === 0) {
      this.log(flags.status ? `No ${flags.status} payments recorded.` : 'No payments recorded yet.');
      return;
    }

    for (const entry of entries) {
      this.log(renderEntry(entry));
    }

    this.log('');
    this.log(renderSummary(entries));
  }
}
