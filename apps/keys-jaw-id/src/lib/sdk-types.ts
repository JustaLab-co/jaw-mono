export interface AppMetadata {
  appName: string;
  appLogoUrl: string;
  defaultChainId?: number;
  appChainIds?: number[];
}

export type chain = {
  id: number;
  rpcUrl?: string;
  paymaster?: {
    url: string;
    context?: Record<string, unknown>;
  };
};

export enum SDKRequestType {
  CONNECT = 'connect',
  SIGN_MESSAGE = 'sign_message',
  SIGN_TYPED_DATA = 'sign_typed_data',
  SEND_TRANSACTION = 'send_transaction',
  CHAIN_ID = 'chain_id',
  GET_SUB_ACCOUNTS = 'get_sub_accounts',
  IMPORT_SUB_ACCOUNT = 'import_sub_account',
  GRANT_PERMISSIONS = 'grant_permissions',
  REVOKE_PERMISSIONS = 'revoke_permissions',
  ADD_FUNDS = 'add_funds',
  UNSUPPORTED_METHOD = 'unsupported_method',
}
