import { eq } from 'drizzle-orm';
import { base } from 'viem/chains';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyBearer, type Tenant } from '@/connections/auth';
import { WalletBusy, type Ask, type OpenWallet } from '@/connections/relay';
import {
  callTool,
  connect,
  fakeWallet,
  mcp,
  owner,
  setTestEnv,
  walletAnswers,
  walletsSettled,
} from '@/connections/testkit';
import { USER_REJECTED } from '@/connections/wallet-codes';
import { getDb } from '@/db/client';
import { permissionRequests } from '@/db/schema';
import { hitsThisWindow, TEST_PG_URL, useTestDb, useTestPostgres } from '@/db/test-db';
import { RATE_WINDOW_MS } from '@/lib/edge';
import { chainName } from '@/lib/owner-text';
import { MAX_ADD_FUNDS_PER_ACCOUNT } from '@/owner-calls/cap';
import { leaks, spoken, toAgent } from '@/test-utils/spoken';
import { sendCalls } from './owner-calls';
import { addFunds, type AddFundsDeps } from './add-funds';
import { FOR_AGENT } from './reply';

// The server's own chain, swapped for a mainnet in the tests that need one.
const deployment = vi.hoisted(() => ({ chain: undefined as undefined | import('viem').Chain }));
vi.mock('@/connections/config', async (original) => {
  const mod = await original<typeof import('@/connections/config')>();
  return { ...mod, config: () => ({ ...mod.config(), ...(deployment.chain && { chain: deployment.chain }) }) };
});

setTestEnv();
beforeAll(TEST_PG_URL ? useTestPostgres : useTestDb);
afterEach(() => (deployment.chain = undefined));

const MAINNETS = [8453, 1, 10];
const TESTNETS = [84532, 11155111];

/** The proxy's answer: mainnets only unless testnets are asked for, as wallet_getCapabilities filters them. */
function capabilities(o: { fail?: Error } = {}) {
  const asked: { account: string; showTestnets: boolean }[] = [];
  const capabilityChains: AddFundsDeps['capabilityChains'] = async (account, showTestnets) => {
    asked.push({ account, showTestnets });
    if (o.fail) throw o.fail;
    return showTestnets ? [...MAINNETS, ...TESTNETS] : MAINNETS;
  };
  return { asked, capabilityChains };
}

async function connected(signer = owner()) {
  const c = await connect(signer, { scope: 'wallet:read' });
  await walletsSettled();
  return { c, signer, t: (await verifyBearer(c.access_token))?.extra?.tenant as Tenant };
}

function held() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}

/** A wallet that closes the Add Funds screen with null, as the SDK does whether or not funds were sent. */
function setup(signer: ReturnType<typeof owner>) {
  const asked: { method: string; params: unknown[] }[] = [];
  const chains: number[] = [];
  const deps = (o: { held?: Promise<void>; answer?: Ask } = {}): AddFundsDeps => {
    const answers = walletAnswers(signer);
    const wallet = fakeWallet(async (method, params) => {
      await o.held;
      if (o.answer) return o.answer(method, params);
      return method === 'wallet_addFunds' ? null : answers(method, params);
    }, asked);
    const openWallet: OpenWallet = async (...args) => (chains.push(args[0]), wallet(...args));
    return { openWallet, capabilityChains: capabilities().capabilityChains };
  };
  return { asked, deps, opened: () => chains.length, chains };
}

const rowsOf = (t: Tenant) =>
  getDb().select().from(permissionRequests).where(eq(permissionRequests.connectionId, t.connectionId));

const urlOf = (r: Awaited<ReturnType<typeof addFunds>>) =>
  'structuredContent' in r ? r.structuredContent?.url : undefined;

const textOf = (r: Awaited<ReturnType<typeof addFunds>>) => r.content[0].text;
const refused = (r: Awaited<ReturnType<typeof addFunds>>) => 'isError' in r && r.isError;
const chainsOf = (r: Awaited<ReturnType<typeof addFunds>>) =>
  'structuredContent' in r ? r.structuredContent?.chains : undefined;

// Every network the capabilities above list on a testnet server, by name, the one asked for first.
const ALL_FROM_BASE_SEPOLIA = 'Base Sepolia, Base, Ethereum, OP Mainnet, Sepolia';
const ALL_FROM_BASE = 'Base, Base Sepolia, Ethereum, OP Mainnet, Sepolia';
const anyNetwork = (account: string, can: 'also' | 'still', names: string) =>
  `Funds can ${can} be sent directly to ${account} on any network the wallet supports: ${names}.`;

describe('jaw_add_funds', () => {
  it("given no chainId and the owner opens the link, then the wallet shows Add Funds on the connection's chain and the reply carries the link and where to deposit", async () => {
    const { t, signer } = await connected();
    const { deps, asked, chains } = setup(signer);

    const result = await addFunds(t, {}, deps());
    await walletsSettled();

    expect('structuredContent' in result && result.structuredContent).toEqual({
      url: expect.stringMatching(/cli-bridge/),
      approveBy: expect.any(String),
      address: t.account,
      chains: ['eip155:84532', 'eip155:8453', 'eip155:1', 'eip155:10', 'eip155:11155111'],
      summary: expect.stringContaining(`${FOR_AGENT} Read the balance now with jaw_get_assets and chainIds [84532].`),
    });
    expect(textOf(result)).toContain(anyNetwork(t.account, 'also', ALL_FROM_BASE_SEPOLIA));
    expect(textOf(result)).not.toMatch(/USDC/);
    expect(chains).toEqual([t.chainId]);
    expect(asked.map((a) => a.method)).toEqual(['eth_requestAccounts', 'wallet_addFunds']);
    expect(asked[1].params).toEqual([{ chainId: t.chainId }]);
    expect(await rowsOf(t)).toMatchObject([{ method: 'add_funds', chainId: t.chainId, state: 'approved', code: null }]);
  });

  it('given the tool is called over MCP, then it answers with an owner link', async () => {
    const { c } = await connected();
    // No relay runs in this test, so the link ends unanswered.
    const r = await callTool(c.access_token, 'jaw_add_funds', {});
    await walletsSettled();
    expect(r.isError ?? false).toBe(false);
    expect(r.structuredContent.url).toEqual(expect.any(String));
  });

  it('given a chainId the wallet supports, then the link opens on that chain, the wallet shows Add Funds there and the reply names it', async () => {
    const { t, signer } = await connected();
    const { deps, asked, chains } = setup(signer);

    const result = await addFunds(t, { chainId: 8453 }, deps());
    await walletsSettled();

    expect('structuredContent' in result && result.structuredContent).toMatchObject({
      address: t.account,
      chains: ['eip155:8453', 'eip155:84532', 'eip155:1', 'eip155:10', 'eip155:11155111'],
      summary: expect.stringContaining(anyNetwork(t.account, 'also', ALL_FROM_BASE)),
    });
    expect(toAgent(result).join('\n')).toContain('Read the balance now with jaw_get_assets and chainIds [8453].');
    expect(chains).toEqual([8453]);
    expect(asked[1]).toEqual({ method: 'wallet_addFunds', params: [{ chainId: 8453 }] });
    expect(await rowsOf(t)).toMatchObject([{ chainId: 8453, state: 'approved' }]);
    expect(JSON.parse((await rowsOf(t))[0].payload!)).toEqual({ chainId: 8453 });
  });

  it('given a chainId the wallet does not support, then it is refused and no wallet opens', async () => {
    const { t, signer } = await connected();
    const { deps, opened } = setup(signer);

    const result = await addFunds(t, { chainId: 324 }, deps());

    expect(refused(result)).toBe(true);
    expect(textOf(result)).toMatch(/^unsupported_chain: /);
    expect(spoken(result)).toBe(
      'The wallet cannot receive on that network here. It can on Base Sepolia, Base, Ethereum, OP Mainnet and Sepolia.'
    );
    expect(toAgent(result).join('\n')).toContain('Chain 324 is not one the wallet supports here');
    expect(opened()).toBe(0);
    expect(await rowsOf(t)).toEqual([]);
  });

  it("given no chainId or the connection's own chain, then the screen opens after one capabilities lookup, for the networks named, with no check of the chain, and a failed lookup names that network alone", async () => {
    const { t, signer } = await connected();
    const { deps } = setup(signer);
    const failing = () => capabilities({ fail: new Error('the capabilities cannot be read') });
    const unnamed = failing();
    const own = failing();

    const result = await addFunds(t, {}, { ...deps(), capabilityChains: unnamed.capabilityChains });
    const named = await addFunds(t, { chainId: t.chainId }, { ...deps(), capabilityChains: own.capabilityChains });
    await walletsSettled();

    expect(refused(result)).toBe(false);
    expect(refused(named)).toBe(false);
    for (const r of [result, named]) {
      expect(chainsOf(r)).toEqual([`eip155:${t.chainId}`]);
      expect(spoken(r)).toContain(`Funds can also be sent directly to ${t.account} on Base Sepolia.`);
    }
    expect(unnamed.asked).toEqual([{ account: t.account, showTestnets: true }]);
    expect(own.asked).toEqual([{ account: t.account, showTestnets: true }]);
  });

  it('given a chainId the wallet supports, then the screen opens after exactly one capabilities lookup, which both checks the chain and names the networks', async () => {
    const { t, signer } = await connected();
    const { deps } = setup(signer);
    const lookup = capabilities();

    const result = await addFunds(t, { chainId: 8453 }, { ...deps(), capabilityChains: lookup.capabilityChains });
    await walletsSettled();

    expect(refused(result)).toBe(false);
    expect(spoken(result)).toContain(anyNetwork(t.account, 'also', ALL_FROM_BASE));
    expect(lookup.asked).toEqual([{ account: t.account, showTestnets: true }]);
  });

  it('given a mainnet server and a testnet chainId, then it is refused unsupported_chain, the proxy is asked for mainnets only and no wallet opens', async () => {
    deployment.chain = base;
    const { t, signer } = await connected();
    const { deps, opened } = setup(signer);
    const lookup = capabilities();

    const result = await addFunds(t, { chainId: 11155111 }, { ...deps(), capabilityChains: lookup.capabilityChains });

    expect(refused(result)).toBe(true);
    expect(textOf(result)).toMatch(/^unsupported_chain: /);
    expect(t.chainId).toBe(8453);
    expect(spoken(result)).toBe(
      'The wallet cannot receive on that network here. It can on Base, Ethereum and OP Mainnet.'
    );
    expect(toAgent(result).join('\n')).toContain('Chain 11155111 is not one the wallet supports here');
    expect(lookup.asked).toEqual([{ account: t.account, showTestnets: false }]);
    expect(opened()).toBe(0);
    expect(await rowsOf(t)).toEqual([]);
  });

  it('given a mainnet server and a mainnet chainId, then the link opens on that chain', async () => {
    deployment.chain = base;
    const { t, signer } = await connected();
    const { deps, chains } = setup(signer);
    const lookup = capabilities();

    const result = await addFunds(t, { chainId: 10 }, { ...deps(), capabilityChains: lookup.capabilityChains });
    await walletsSettled();

    expect(refused(result)).toBe(false);
    expect(chainsOf(result)).toEqual(['eip155:10', 'eip155:8453', 'eip155:1']);
    expect(spoken(result)).toContain(anyNetwork(t.account, 'also', 'OP Mainnet, Base, Ethereum'));
    expect(lookup.asked).toEqual([{ account: t.account, showTestnets: false }]);
    expect(chains).toEqual([10]);
  });

  it('given a testnet server, then the proxy is asked with testnets and a testnet chainId opens', async () => {
    const { t, signer } = await connected();
    const { deps, chains } = setup(signer);
    const lookup = capabilities();

    const result = await addFunds(t, { chainId: 11155111 }, { ...deps(), capabilityChains: lookup.capabilityChains });
    await walletsSettled();

    expect(refused(result)).toBe(false);
    expect(lookup.asked).toEqual([{ account: t.account, showTestnets: true }]);
    expect(chains).toEqual([11155111]);
    // jaw_get_assets reads only mainnets and the connection's own chain, so the agent is not sent to read Sepolia.
    const agent = toAgent(result).join('\n');
    expect(agent).not.toContain('jaw_get_assets');
    expect(agent).toContain(`The balance on ${chainName(11155111)} cannot be read here, so do not check it.`);
  });

  it("given the capabilities lookup fails, then it is refused proxy_error with the address on the connection's chain and no wallet opens", async () => {
    const { t, signer } = await connected();
    const { deps, opened } = setup(signer);
    const lookup = capabilities({ fail: new Error('proxy down') });

    const result = await addFunds(t, { chainId: 8453 }, { ...deps(), capabilityChains: lookup.capabilityChains });

    expect(refused(result)).toBe(true);
    expect(textOf(result)).toMatch(/^proxy_error: /);
    expect(spoken(result)).toBe(
      `The networks the wallet supports could not be checked right now, so the screen did not open. Funds can still be sent directly to ${t.account} on Base Sepolia.`
    );
    expect(toAgent(result)).toEqual([
      `${FOR_AGENT} Chain 8453 could not be checked: proxy down. Ask again, or leave chainId out for this connection's chain.`,
    ]);
    expect(opened()).toBe(0);
    expect(await rowsOf(t)).toEqual([]);
  });

  it('given a link waiting on a chainId, when the agent asks for it again and the capabilities lookup would fail, then the waiting link comes back without checking the chain again, naming the networks already known', async () => {
    const { t, signer } = await connected();
    const { deps, opened } = setup(signer);
    const wait = held();
    const holding = deps({ held: wait.promise });
    const lookup = capabilities({ fail: new Error('proxy down') });

    const first = await addFunds(t, { chainId: 8453 }, holding);
    const again = await addFunds(t, { chainId: 8453 }, { ...holding, capabilityChains: lookup.capabilityChains });
    wait.release();
    await walletsSettled();

    expect(refused(again)).toBe(false);
    expect(urlOf(again)).toBe(urlOf(first));
    expect(chainsOf(again)).toEqual(['eip155:8453', `eip155:${t.chainId}`]);
    expect(spoken(again)).toContain(anyNetwork(t.account, 'also', 'Base, Base Sepolia'));
    expect(opened()).toBe(1);
  });

  it('given a link waiting on one chain, when the agent asks for another, then the waiting link is named, not returned, and the address still comes back', async () => {
    const { t, signer } = await connected();
    const { deps, opened } = setup(signer);
    const wait = held();
    const holding = deps({ held: wait.promise });

    const first = await addFunds(t, {}, holding);
    const other = await addFunds(t, { chainId: 8453 }, holding);
    const same = await addFunds(t, {}, holding);
    wait.release();
    await walletsSettled();

    expect(refused(other)).toBe(true);
    expect(textOf(other)).toMatch(/^add_funds_in_progress: /);
    const esc = (s: string) => s.replace(/[.?]/g, '\\$&');
    expect(spoken(other)).toMatch(
      new RegExp(
        `^An Add Funds link for Base Sepolia is already open; it expires in (29|30) minutes\\. ${esc(anyNetwork(t.account, 'still', ALL_FROM_BASE))}\\nOpen this link to add funds: ${esc(urlOf(first)!)}$`
      )
    );
    expect(toAgent(other)).toEqual([
      `${FOR_AGENT} Ask again with chainId ${t.chainId} to get that link, or with 8453 once it ends.`,
    ]);
    expect('structuredContent' in other).toBe(false);
    expect(urlOf(same)).toBe(urlOf(first));
    expect(opened()).toBe(1);
    expect(await rowsOf(t)).toMatchObject([{ chainId: t.chainId }]);
  });

  it('given three other links waiting on the account, then an Add Funds link still opens', async () => {
    const signer = owner();
    const others = [await connected(signer), await connected(signer), await connected(signer)];
    const { t } = await connected(signer);
    const { deps, opened } = setup(signer);
    // The owner opens none of these links until the end, so each keeps its slot.
    const wait = held();
    const declining = fakeWallet(async () => {
      await wait.promise;
      throw Object.assign(new Error('declined'), { code: USER_REJECTED });
    }, []);
    const openDeclining: OpenWallet = async (...args) => declining(...args);
    for (const o of others) {
      const r = await sendCalls(
        o.t,
        { calls: [{ to: '0x000000000000000000000000000000000000dEaD' }] },
        { openWallet: openDeclining, receipt: async () => null, clients: {} as never }
      );
      expect(r.isError ?? false).toBe(false);
    }

    const result = await addFunds(t, { chainId: 8453 }, deps({ held: wait.promise }));
    wait.release();
    await walletsSettled();

    expect(refused(result)).toBe(false);
    expect(urlOf(result)).toMatch(/cli-bridge/);
    expect(opened()).toBe(1);
  });

  it('given Add Funds links waiting on as many connections as the account may hold, then jaw_send_calls on the account still opens', async () => {
    const signer = owner();
    const waiting = [];
    for (let i = 0; i < MAX_ADD_FUNDS_PER_ACCOUNT; i++) waiting.push(await connected(signer));
    const { t } = await connected(signer);
    const { deps } = setup(signer);
    const wait = held();
    const holding = deps({ held: wait.promise });
    for (const w of waiting) expect(refused(await addFunds(w.t, {}, holding))).toBe(false);

    const send = await sendCalls(
      t,
      { calls: [{ to: '0x000000000000000000000000000000000000dEaD' }] },
      { openWallet: holding.openWallet, receipt: async () => null, clients: {} as never }
    );
    wait.release();
    await walletsSettled();

    expect(send.isError ?? false).toBe(false);
    expect(send.content[0].text).not.toMatch(/^account_busy: /);
  });

  it('given Add Funds links waiting on as many connections as the account may hold, when another connection asks, then it is add_funds_busy, names the address and no other link, and no wallet opens', async () => {
    const signer = owner();
    const waiting = [];
    for (let i = 0; i < MAX_ADD_FUNDS_PER_ACCOUNT; i++) waiting.push(await connected(signer));
    const { t } = await connected(signer);
    const { deps, opened } = setup(signer);
    const wait = held();
    const holding = deps({ held: wait.promise });
    const links = [];
    for (const w of waiting) links.push(urlOf(await addFunds(w.t, {}, holding)));

    const result = await addFunds(t, { chainId: 8453 }, holding);
    wait.release();
    await walletsSettled();

    expect(refused(result)).toBe(true);
    expect(textOf(result)).toMatch(
      new RegExp(`^add_funds_busy: The wallet already has ${MAX_ADD_FUNDS_PER_ACCOUNT} Add Funds screens waiting\\. `)
    );
    expect(spoken(result)).toContain(anyNetwork(t.account, 'still', ALL_FROM_BASE));
    for (const url of links) expect(textOf(result)).not.toContain(url);
    expect('structuredContent' in result).toBe(false);
    expect(opened()).toBe(MAX_ADD_FUNDS_PER_ACCOUNT);
    expect(await rowsOf(t)).toEqual([]);
  });

  it('given Add Funds links racing from more connections than the account may hold, then only that many open', async () => {
    const signer = owner();
    const racing = [];
    for (let i = 0; i < MAX_ADD_FUNDS_PER_ACCOUNT + 2; i++) racing.push(await connected(signer));
    const { deps, opened } = setup(signer);
    const wait = held();
    const holding = deps({ held: wait.promise });

    const results = await Promise.all(racing.map((r) => addFunds(r.t, {}, holding)));
    wait.release();
    await walletsSettled();

    expect(results.filter((r) => !refused(r))).toHaveLength(MAX_ADD_FUNDS_PER_ACCOUNT);
    expect(results.filter((r) => textOf(r).startsWith('add_funds_busy: '))).toHaveLength(2);
    expect(opened()).toBeGreaterThanOrEqual(MAX_ADD_FUNDS_PER_ACCOUNT);
  });

  it('given the wallet pool is full, then the refusal is wallet_busy and still names the address on the asked chain', async () => {
    const { t } = await connected();
    const busy: OpenWallet = async () => {
      throw new WalletBusy();
    };

    const result = await addFunds(
      t,
      { chainId: 8453 },
      { openWallet: busy, capabilityChains: capabilities().capabilityChains }
    );

    expect(refused(result)).toBe(true);
    expect(textOf(result)).toMatch(/^Too many owners are approving right now, so the screen did not open\. /);
    expect(spoken(result)).toContain(anyNetwork(t.account, 'still', ALL_FROM_BASE));
    expect(toAgent(result)).toEqual([`${FOR_AGENT} Try again in a minute.`]);
    expect(await rowsOf(t)).toEqual([]);
  });

  it('given the wallet is signed in to another account, then the screen is never shown and the request reads wrong_account', async () => {
    const { t } = await connected();
    const { deps, asked } = setup(owner());

    await addFunds(t, {}, deps());
    await walletsSettled();

    expect(asked.map((a) => a.method)).toEqual(['eth_requestAccounts']);
    expect(await rowsOf(t)).toMatchObject([{ state: 'owner_declined', code: 'wrong_account' }]);
  });

  it('given the owner rejects in the wallet, then the request reads declined', async () => {
    const { t, signer } = await connected();
    const { deps } = setup(signer);
    const rejecting = walletAnswers(signer, ['wallet_addFunds']);

    await addFunds(t, {}, deps({ answer: rejecting }));
    await walletsSettled();

    expect(await rowsOf(t)).toMatchObject([{ state: 'owner_declined' }]);
  });

  it('given a link still waiting for the owner, when the agent asks again many times, then each gets the same link and none is rate_limited', async () => {
    await clearOfMinuteEdge();
    const { t, signer } = await connected();
    const { deps, opened } = setup(signer);
    const wait = held();
    const holding = deps({ held: wait.promise });

    const answers = [];
    for (let i = 0; i < 15; i++) answers.push(await addFunds(t, {}, holding));
    wait.release();
    await walletsSettled();

    expect(new Set(answers.map(urlOf)).size).toBe(1);
    expect(urlOf(answers[0])).toMatch(/cli-bridge/);
    expect(opened()).toBe(1);
  });

  it('given another app on the account waits on its own link, then this connection gets a link of its own', async () => {
    const signer = owner();
    const mine = await connected(signer);
    const other = await connected(signer);
    const { deps, opened } = setup(signer);
    const wait = held();
    const holding = deps({ held: wait.promise });

    const theirs = await addFunds(other.t, {}, holding);
    const ours = await addFunds(mine.t, {}, holding);
    wait.release();
    await walletsSettled();

    expect(opened()).toBe(2);
    expect(urlOf(ours)).not.toBe(urlOf(theirs));
  });

  it('given ten links in a minute on one connection, when an eleventh comes, then it is rate_limited and no wallet opens', async () => {
    await clearOfMinuteEdge();
    const { t, signer } = await connected();
    const { deps, opened } = setup(signer);

    for (let i = 0; i < 10; i++) {
      await addFunds(t, {}, deps());
      await walletsSettled();
    }
    const over = await addFunds(t, {}, deps());

    expect(over.content[0].text).toMatch(/^rate_limited: /);
    expect(opened()).toBe(10);
  });

  it("given too many links this minute, when no chainId is asked, then the refusal reads no capabilities and names the connection's network alone", async () => {
    const { t, signer } = await connected();
    await hitsThisWindow(`owner-add-funds:${t.connectionId}`, 10, RATE_WINDOW_MS);
    const lookup = capabilities();

    const over = await addFunds(t, {}, { ...setup(signer).deps(), capabilityChains: lookup.capabilityChains });

    expect(textOf(over)).toMatch(/^rate_limited: /);
    expect(spoken(over)).toBe(
      `Too many Add Funds requests in a short time, so the screen did not open. Funds can still be sent directly to ${t.account} on Base Sepolia.`
    );
    expect(lookup.asked).toEqual([]);
  });

  it("given too many links this minute, when another chain is asked, then the refusal names that chain and the connection's after the one check of the chain", async () => {
    const { t, signer } = await connected();
    await hitsThisWindow(`owner-add-funds:${t.connectionId}`, 10, RATE_WINDOW_MS);
    const lookup = capabilities();

    const over = await addFunds(
      t,
      { chainId: 8453 },
      { ...setup(signer).deps(), capabilityChains: lookup.capabilityChains }
    );

    expect(textOf(over)).toMatch(/^rate_limited: /);
    expect(spoken(over)).toContain(anyNetwork(t.account, 'still', 'Base, Base Sepolia'));
    expect(lookup.asked).toEqual([{ account: t.account, showTestnets: true }]);
  });
});

async function clearOfMinuteEdge() {
  const intoMinute = Date.now() % 60_000;
  if (intoMinute > 50_000) await new Promise((resolve) => setTimeout(resolve, 60_500 - intoMinute));
}

describe('what the owner hears from jaw_add_funds', () => {
  type Read = () => Promise<Awaited<ReturnType<typeof addFunds>>>;

  it('given the link opens, then it comes first on its own line, then the address once and every network it works on, and the agent is told to read the balance on that network and speak only if funds arrived', async () => {
    const { t, signer } = await connected();
    const { deps } = setup(signer);
    const wait = held();

    const result = await addFunds(t, {}, deps({ held: wait.promise }));
    wait.release();
    await walletsSettled();

    const url = urlOf(result)!;
    expect(textOf(result).split('\n')).toEqual([
      `Open this link to add funds: ${url}`,
      `It shows the wallet address and a QR code, and works for the next 30 minutes. ${anyNetwork(t.account, 'also', ALL_FROM_BASE_SEPOLIA)}`,
      `${FOR_AGENT} Read the balance now with jaw_get_assets and chainIds [${t.chainId}]. Tell the owner the funds arrived only if it now covers what was missing, or is higher than a balance you read on that network earlier; otherwise say nothing about it. On the owner's next messages, read it again on that chain before answering, and continue the original request once it covers it. The screen closing does not mean funds arrived.`,
    ]);
    expect(textOf(result).split(t.account)).toHaveLength(2);
    expect(leaks(spoken(result))).toEqual([]);
  });

  it('given the supported networks never answer, then the link still comes back, naming the network it opens on', async () => {
    const { t, signer } = await connected();
    const { deps } = setup(signer);
    const wait = held();
    const silent: AddFundsDeps['capabilityChains'] = () => new Promise(() => {});

    const result = await addFunds(t, {}, { ...deps({ held: wait.promise }), capabilityChains: silent });
    wait.release();
    await walletsSettled();

    expect(refused(result)).toBe(false);
    expect(urlOf(result)).toMatch(/cli-bridge/);
    expect(chainsOf(result)).toEqual([`eip155:${t.chainId}`]);
    expect(spoken(result)).toContain(`Funds can also be sent directly to ${t.account} on Base Sepolia.`);
  });

  it('given the tools list, then jaw_add_funds is titled and its description holds the balance read back', async () => {
    const { c } = await connected();

    const { json } = await mcp(c.access_token, { method: 'tools/list' });

    const tool = json.result.tools.find((x: { name: string }) => x.name === 'jaw_add_funds');
    expect(tool.title).toBe('Add funds to the wallet');
    expect(tool.annotations).toMatchObject({ destructiveHint: false, idempotentHint: true });
    expect(tool.description).toContain(
      'Then check the balance with jaw_get_assets on that network, and tell the owner the funds arrived only when it now covers what was missing or is higher than a balance you read there earlier; otherwise say nothing, since funds take time to arrive.'
    );
    expect(tool.description).toContain('The wallet has one address on every network it supports');
  });

  const REFUSALS: [string, RegExp, Read][] = [
    [
      'a chain the wallet does not support',
      /^unsupported_chain: /,
      async () => {
        const { t, signer } = await connected();
        return addFunds(t, { chainId: 324 }, setup(signer).deps());
      },
    ],
    [
      'a testnet on a mainnet server',
      /^unsupported_chain: /,
      async () => {
        deployment.chain = base;
        const { t, signer } = await connected();
        return addFunds(t, { chainId: 11155111 }, setup(signer).deps());
      },
    ],
    [
      'a capabilities lookup that fails',
      /^proxy_error: /,
      async () => {
        const { t, signer } = await connected();
        const lookup = capabilities({ fail: new Error('proxy down') });
        return addFunds(t, { chainId: 8453 }, { ...setup(signer).deps(), capabilityChains: lookup.capabilityChains });
      },
    ],
    [
      'a link waiting on another chain',
      /^add_funds_in_progress: /,
      async () => {
        const { t, signer } = await connected();
        const wait = held();
        const holding = setup(signer).deps({ held: wait.promise });
        await addFunds(t, {}, holding);
        const other = await addFunds(t, { chainId: 8453 }, holding);
        wait.release();
        await walletsSettled();
        return other;
      },
    ],
    [
      'every Add Funds slot of the account taken',
      /^add_funds_busy: /,
      async () => {
        const signer = owner();
        const waiting = [];
        for (let i = 0; i < MAX_ADD_FUNDS_PER_ACCOUNT; i++) waiting.push(await connected(signer));
        const { t } = await connected(signer);
        const wait = held();
        const holding = setup(signer).deps({ held: wait.promise });
        for (const w of waiting) await addFunds(w.t, {}, holding);
        const result = await addFunds(t, {}, holding);
        wait.release();
        await walletsSettled();
        return result;
      },
    ],
    [
      'a full owner pool',
      /^Too many owners are approving right now/,
      async () => {
        const { t } = await connected();
        const busy: OpenWallet = async () => {
          throw new WalletBusy();
        };
        return addFunds(t, {}, { openWallet: busy, capabilityChains: capabilities().capabilityChains });
      },
    ],
    [
      'too many links this minute',
      /^rate_limited: /,
      async () => {
        const { t, signer } = await connected();
        await hitsThisWindow(`owner-add-funds:${t.connectionId}`, 10, RATE_WINDOW_MS);
        return addFunds(t, {}, setup(signer).deps());
      },
    ],
  ];

  it.each(REFUSALS)(
    'given %s, then it is refused with its code first and the owner hears no tool and no internal word',
    async (_name, code, read) => {
      const result = await read();

      expect(refused(result)).toBe(true);
      expect(textOf(result)).toMatch(code);
      expect(spoken(result).trim()).not.toBe('');
      expect(leaks(spoken(result))).toEqual([]);
      for (const line of toAgent(result)) expect(line.startsWith(FOR_AGENT)).toBe(true);
    }
  );
});
