import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import { getBridge } from '../../lib/bridge-singleton.js';
import { loadConfig } from '../../lib/config.js';
import { requiresBrowser, supportsSessionMode } from '../../lib/rpc-classifier.js';
import { SessionBridge } from '../../lib/session-bridge.js';
import type { OutputFormat } from '../../lib/types.js';

export default class RpcCall extends BaseCommand {
  static override description = 'Execute any JAW.id RPC method via the browser bridge or local session key.';

  static override examples = [
    '<%= config.bin %> rpc call wallet_sendCalls \'{"calls":[{"to":"0x...","value":"0x0"}]}\'',
    '<%= config.bin %> rpc call personal_sign \'"Hello World"\'',
    '<%= config.bin %> rpc call wallet_getAssets',
    '<%= config.bin %> rpc call eth_requestAccounts',
    '<%= config.bin %> rpc call wallet_getCallsStatus \'"0x..."\'',
    '<%= config.bin %> rpc call wallet_sendCalls \'{"calls":[...]}\' --session',
  ];

  static override args = {
    method: Args.string({
      description: 'EIP-1193 RPC method name',
      required: true,
    }),
    params: Args.string({
      description: 'Method parameters as JSON string',
      required: false,
    }),
  };

  static override flags = {
    ...BaseCommand.baseFlags,
    timeout: Flags.integer({
      char: 't',
      // No default. A default is indistinguishable from an explicit value, and
      // this one was passed to getBridge on every run, which made
      // JAW_BRIDGE_TIMEOUT_MS dead here: the env only applies when no caller
      // named a timeout. The error text tells people to raise that knob, so it
      // has to work in the command most likely to hit it. Unset falls through
      // to the env, then to the built-in 120 seconds.
      description: 'Request timeout in seconds (default 120, or JAW_BRIDGE_TIMEOUT_MS)',
    }),
    session: Flags.boolean({
      char: 's',
      description: 'Use local session key (auto mode)',
      default: false,
      env: 'JAW_SESSION',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(RpcCall);
    const { method } = args;

    let params: unknown;
    if (args.params) {
      try {
        params = JSON.parse(args.params);
      } catch {
        this.error(`Invalid JSON params: ${args.params}`);
      }
    }

    const format = flags.output as OutputFormat;
    const config = loadConfig();
    const apiKey = this.resolveApiKey(flags);
    const chainId = flags.chain ?? config.defaultChain ?? 1;

    let bridge: { request(method: string, params?: unknown): Promise<unknown>; close(): void };

    if (flags.session) {
      if (!supportsSessionMode(method)) {
        this.error(
          `Method ${method} is not supported in session mode. ` +
            'Use without --session to route through the browser bridge.'
        );
      }

      // Session mode signs locally and opens nothing, so there is no browser to
      // fill a key in. Refused here rather than left to fail at the proxy,
      // where the error names an authorization problem and not the fix.
      if (!apiKey) {
        this.error(
          'Session mode needs an API key, and there is no browser in this path to get one. ' +
            'Run `jaw session setup` to have one issued, set one with `jaw config set apiKey <key>`, ' +
            'or drop --session to route through the browser bridge.'
        );
      }

      bridge = new SessionBridge({ apiKey, chainId });

      if (!flags.quiet) {
        this.log(`Sending ${method} (session mode)...`);
      }
    } else {
      bridge = await getBridge({
        keysUrl: config.keysUrl,
        apiKey,
        chainId,
        ens: config.ens,
        // Undefined when the flag was not given, so getBridge falls through to
        // the env knob and then to its own default.
        timeout: flags.timeout === undefined ? undefined : flags.timeout * 1000,
      });

      if (!flags.quiet) {
        if (requiresBrowser(method)) {
          this.log(`Sending ${method}... Check your browser to approve the request.`);
        } else {
          this.log(`Sending ${method}...`);
        }
      }
    }

    try {
      const result = await bridge.request(method, params);
      this.outputResult(result, format);
    } finally {
      bridge.close();
    }
  }
}
