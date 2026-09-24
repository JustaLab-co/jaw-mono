import { BaseCommand } from '../../base-command.js';
import { setConfigValue, setX402PolicyValue } from '../../lib/config.js';
import { isX402PolicyKey, X402_ARRAY_KEYS, X402_SCALAR_KEYS } from '../../x402/policy.js';
import { parseLimit } from '../../x402/grant-preset.js';

const VALID_KEYS = [
  'apiKey',
  'defaultChain',
  'keysUrl',
  'ens',
  'relayUrl',
  'sessionExpiry',
  // Settable here and nowhere else. Like the x402 policy fields below, the MCP
  // tool cannot reach it, so an agent cannot raise the ceiling on what it is
  // allowed to ask a human to approve.
  'grantCeiling',
] as const;

// Built from the policy's own lists, not written out beside them. The copy that
// was written out fell behind `topUpFloat`, so the command answered a key it
// accepts with a list that does not name it.
const VALID_KEYS_HINT = `Valid keys: ${VALID_KEYS.join(', ')}, x402.<${[...X402_SCALAR_KEYS, ...X402_ARRAY_KEYS].join('|')}>`;

type ValidKey = (typeof VALID_KEYS)[number];

function isValidKey(key: string): key is ValidKey {
  return VALID_KEYS.includes(key as ValidKey);
}

// x402 policy fields are addressed as `x402.<field>` (e.g. x402.maxAmountPerPayment).
// Array fields take a comma-separated value. This lives on the CLI only — the MCP
// tool cannot set the policy, so an agent cannot widen its own spending caps.
function isSettableKey(key: string): boolean {
  return isValidKey(key) || (key.startsWith('x402.') && isX402PolicyKey(key.slice('x402.'.length)));
}

export default class ConfigSet extends BaseCommand {
  static override description = 'Set one or more configuration values. Accepts key=value pairs or a single key value.';

  static override examples = [
    '<%= config.bin %> config set apiKey=your-api-key defaultChain=8453',
    '<%= config.bin %> config set ens=yourdomain.eth sessionExpiry=14',
    '<%= config.bin %> config set apiKey your-api-key',
    '<%= config.bin %> config set x402.maxAmountPerPayment=50000 x402.maxTotalPerSession=1000000',
    '<%= config.bin %> config set x402.allowedNetworks=eip155:8453,eip155:84532',
  ];

  static override strict = false;

  static override args = {};

  static override flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<void> {
    const { argv, flags } = await this.parse(ConfigSet);
    const rawArgs = argv as string[];

    // Parse key=value pairs from all args
    const entries = this.parseEntries(rawArgs);

    if (entries.length === 0) {
      this.error(
        `No valid key=value pairs provided.\n${VALID_KEYS_HINT}\nUsage: jaw config set key=value [key=value ...]`
      );
    }

    const results: { key: string; value: string | number }[] = [];

    for (const { key, value } of entries) {
      if (key.startsWith('x402.')) {
        const sub = key.slice('x402.'.length);
        if (!isX402PolicyKey(sub)) {
          this.error(`Invalid x402 config key: ${sub}`);
        }
        // Same guard as the branch below: the setter rejects a non-integer
        // amount by throwing, and unhandled that reaches the user as a stack
        // trace instead of the one-line error oclif prints.
        try {
          setX402PolicyValue(sub, value);
        } catch (err) {
          this.error(err instanceof Error ? err.message : String(err));
        }
        results.push({ key, value });
        continue;
      }

      if (!isValidKey(key)) {
        this.error(`Invalid config key: ${key}`);
      }
      // Parsed while the user is still looking at what they typed. A ceiling
      // that cannot be read refuses every grant, which is safe but reports the
      // mistake a long way from where it was made. An empty value clears it.
      if (key === 'grantCeiling' && value.trim() !== '') {
        try {
          parseLimit(value);
        } catch (err) {
          this.error(`Invalid grantCeiling: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      // setConfigValue coerces + validates numeric keys (defaultChain,
      // sessionExpiry) in one place, shared with the MCP tool path.
      try {
        setConfigValue(key, value);
      } catch (err) {
        this.error(err instanceof Error ? err.message : String(err));
      }

      const displayValue = key === 'apiKey' && typeof value === 'string' ? `${value.slice(0, 8)}...` : value;

      results.push({ key, value: displayValue });
    }

    if (flags.output === 'json') {
      this.outputResult(results.length === 1 ? results[0] : results, 'json');
    } else {
      for (const { key, value } of results) {
        this.log(`Set ${key} = ${value}`);
      }
    }
  }

  private parseEntries(rawArgs: string[]): { key: string; value: string }[] {
    const entries: { key: string; value: string }[] = [];
    let i = 0;
    while (i < rawArgs.length) {
      const arg = rawArgs[i];

      if (arg.includes('=')) {
        // key=value syntax
        const eqIndex = arg.indexOf('=');
        const key = arg.slice(0, eqIndex);
        const value = arg.slice(eqIndex + 1);

        if (!isSettableKey(key)) {
          this.error(`Invalid config key: ${key}\n${VALID_KEYS_HINT}`);
        }
        entries.push({ key, value });
        i++;
      } else if (isSettableKey(arg) && i + 1 < rawArgs.length) {
        // key value syntax (legacy)
        entries.push({ key: arg, value: rawArgs[i + 1] });
        i += 2;
      } else {
        // Both ways of getting here read the same to whoever typed it: a key
        // that is not one, and a key that is one with no value after it.
        this.error(`Unexpected argument: ${arg}\n${VALID_KEYS_HINT}\nUsage: jaw config set key=value [key=value ...]`);
      }
    }

    return entries;
  }
}
