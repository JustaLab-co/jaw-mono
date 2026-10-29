/** Shared by the bridge tests. No imports, so a `vi.mock` factory can load it without a cycle. */
export type RpcArgs = { method: string; params: unknown[] };

export const created = {
  appNames: [] as string[],
  configs: [] as Record<string, unknown>[],
  handlerOptions: [] as unknown[],
  session: 's1',
  /** The whole query when a test opens the page at another URL than a session link. */
  query: null as string | null,
  request: (async () => null) as (args: RpcArgs) => Promise<unknown>,
};

export const navigationMock = {
  useSearchParams: () => new URLSearchParams(created.query ?? `session=${created.session}&relay=ws://relay.test`),
};

export const uiMock = {
  ReactUIHandler: class {
    constructor(options?: unknown) {
      created.handlerOptions.push(options);
    }
  },
};

export const coreMock = (original: object) => ({
  ...original,
  JAW: {
    create: (config: { appName: string }) => {
      created.appNames.push(config.appName);
      created.configs.push(config);
      return { provider: { request: (args: RpcArgs) => created.request(args) } };
    },
  },
});
