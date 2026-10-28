import * as fs from 'node:fs';
import { BaseCommand } from '../../base-command.js';
import { saveConfig } from '../../lib/config.js';
import type { JawConfig } from '../../lib/types.js';
import { isValidKeysUrl, isValidRelayUrl } from '../../lib/validation.js';
import { parsePermissionsConfig } from '@jaw.id/agent';

export default class ConfigWrite extends BaseCommand {
  static override description = 'Write full config from inline JSON or a file path to ~/.jaw/config.json.';

  static override examples = [
    '<%= config.bin %> config write \'{"apiKey":"...","defaultChain":84532}\'',
    '<%= config.bin %> config write ./jaw-config.json',
  ];

  static override strict = false;

  static override flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<void> {
    const { argv } = await this.parse(ConfigWrite);
    const rawArgs = argv as string[];

    if (rawArgs.length === 0) {
      this.error('Provide inline JSON or a file path.\nUsage: jaw config write \'{"apiKey":"..."}\'');
    }

    // Join all args (handles terminal line wrapping)
    const input = rawArgs.join('').trim();

    let raw: string;
    if (input.startsWith('{')) {
      raw = input;
    } else {
      if (!fs.existsSync(input)) {
        this.error(`File not found: ${input}`);
      }
      raw = fs.readFileSync(input, 'utf-8');
    }

    let config: JawConfig;
    try {
      config = JSON.parse(raw) as JawConfig;
    } catch {
      // Terminal wrapping may insert spaces/newlines inside strings — try removing all whitespace
      try {
        const compact = raw.replace(/\s+/g, '');
        config = JSON.parse(compact) as JawConfig;
      } catch {
        this.error('Invalid JSON');
      }
    }

    if (config.keysUrl && !isValidKeysUrl(config.keysUrl)) {
      this.error(`Untrusted keysUrl: ${config.keysUrl}. Must be a *.jaw.id domain (HTTPS) or localhost.`);
    }
    if (config.relayUrl && !isValidRelayUrl(config.relayUrl)) {
      this.error(`Untrusted relayUrl: ${config.relayUrl}. Must be wss://*.jaw.id or ws://localhost.`);
    }
    if (config.permissions) {
      try {
        parsePermissionsConfig(config.permissions);
      } catch (error) {
        this.error((error as Error).message);
      }
    }

    saveConfig(config);
    this.log('Config written to ~/.jaw/config.json');
  }
}
