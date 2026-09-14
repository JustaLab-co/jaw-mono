import * as fs from 'node:fs';
import { PATHS } from './paths.js';
import type { JawConfig, SettableConfigKey } from './types.js';
import type { X402Policy, X402PolicyKey } from '../x402/policy.js';
import { isValidKeysUrl, isValidRelayUrl } from './validation.js';

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

function migrateConfig(config: JawConfig): JawConfig {
  if (config.paymasterUrl && !config.paymasters) {
    const chainId = config.defaultChain ?? 1;
    config.paymasters = { [chainId]: { url: config.paymasterUrl } };
    delete config.paymasterUrl;
    saveConfig(config);
  }
  return config;
}

export function loadConfig(): JawConfig {
  if (!fs.existsSync(PATHS.config)) {
    return {};
  }
  const raw = fs.readFileSync(PATHS.config, 'utf-8');
  try {
    const config = JSON.parse(raw) as JawConfig;
    return migrateConfig(config);
  } catch {
    throw new Error(
      `Config file at ${PATHS.config} is not valid JSON. Run \`jaw config set apiKey=<key>\` to reset it.`
    );
  }
}

export function saveConfig(config: JawConfig): void {
  ensureDir(PATHS.root);
  fs.writeFileSync(PATHS.config, JSON.stringify(config, null, 2) + '\n', {
    encoding: 'utf-8',
    mode: 0o600,
  });
}

/** Paymaster URLs embed provider API keys as query params (e.g. Pimlico's ?apikey=...). */
function redactUrlSecrets(url: string): string {
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      parsed.searchParams.set(key, '***');
    }
    return parsed.toString();
  } catch {
    return '***';
  }
}

export function redactConfig(config: JawConfig): Record<string, unknown> {
  return {
    ...config,
    apiKey: config.apiKey ? `${config.apiKey.slice(0, 8)}...` : undefined,
    // Public by construction, since anything the browser app carries is in its
    // bundle. Truncated anyway: it reads as a credential in `config show` and in
    // the MCP tool's output, and treating it as one costs nothing here.
    workspaceApiKey: config.workspaceApiKey ? `${config.workspaceApiKey.slice(0, 8)}...` : undefined,
    ...(config.paymasters && {
      paymasters: Object.fromEntries(
        Object.entries(config.paymasters).map(([chainId, pm]) => [
          chainId,
          // context is a free-form object (usually just a sponsorshipPolicyId) but a
          // provider could stash a token there, so mask it rather than hand it to the agent.
          { ...pm, url: redactUrlSecrets(pm.url), context: pm.context ? '***' : undefined },
        ])
      ),
    }),
  };
}

/**
 * Set one field of the `x402` payment policy. Array fields (allow-lists) are
 * comma-split. Intentionally NOT reachable from the MCP tool surface: an agent
 * must not be able to raise its own spending caps — only a human at the CLI.
 */
export function setX402PolicyValue(key: X402PolicyKey, value: string): void {
  const config = loadConfig();
  const x402: X402Policy = { ...(config.x402 ?? {}) };
  if (key === 'maxAmountPerPayment' || key === 'maxTotalPerSession' || key === 'topUpFloat') {
    // These are base-unit amounts read via BigInt() on the hot payment path;
    // reject anything that isn't a non-negative integer here so a bad value
    // can never turn into a per-payment failure later.
    if (!/^\d+$/.test(value.trim())) {
      throw new Error(`${key} must be a non-negative integer (base units), got: ${value}`);
    }
    x402[key] = value.trim();
  } else {
    x402[key] = value
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
  }
  saveConfig({ ...config, x402 });
}

export function setConfigValue(key: SettableConfigKey, value: string | number): void {
  if (key === 'keysUrl' && typeof value === 'string' && !isValidKeysUrl(value)) {
    throw new Error(`Untrusted keysUrl: ${value}. Must be a *.jaw.id domain (HTTPS) or localhost.`);
  }
  if (key === 'relayUrl' && typeof value === 'string' && !isValidRelayUrl(value)) {
    throw new Error(`Untrusted relayUrl: ${value}. Must be wss://*.jaw.id or ws://localhost.`);
  }
  // Numeric keys: coerce + validate here so EVERY caller is safe. The MCP tool
  // passes raw strings (its schema types value as a string), so without this a
  // `sessionExpiry: "abc"` would land as a string and turn `expiry * 86400`
  // into NaN, and a `defaultChain` string would ride into an RPC URL verbatim.
  let toStore: string | number = value;
  if (key === 'defaultChain' || key === 'sessionExpiry') {
    // Strict: reject anything parseInt would silently truncate ('1.5' -> 1,
    // '0x10' -> 0, '10abc' -> 10). Only a bare positive decimal integer passes.
    const n = typeof value === 'number' ? value : /^\d+$/.test(value.trim()) ? parseInt(value.trim(), 10) : NaN;
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`${key} must be a positive integer, got: ${JSON.stringify(value)}`);
    }
    toStore = n;
  }
  const config = loadConfig();
  const updated = { ...config, [key]: toStore };
  saveConfig(updated);
}
