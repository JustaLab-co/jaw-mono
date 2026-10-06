import type { PaymentPorts } from '@jaw.id/agent';
import { cliChainClients } from './balance.js';
import { jsonlPaymentLog } from './ledger.js';
import { SessionBridge } from '../lib/session-bridge.js';

export const cliPaymentPorts: PaymentPorts = {
  clients: cliChainClients,
  log: jsonlPaymentLog,
  topUpExecutor: (apiKey, chainId) => new SessionBridge({ apiKey, chainId }),
};
