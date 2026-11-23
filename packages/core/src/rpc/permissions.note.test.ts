/**
 * A note is what the app that asks for a permission says it is for. It is not signed and not part
 * of the permission hash: it travels next to the permission, to the relay and back to the dapp.
 * The rule is checked before any popup or dialog opens, and again on Grant, so a request from an
 * SDK that skipped the first check is still refused.
 *
 * Only the network is mocked: the bundler send, the receipt read and the relay call. The encoder
 * and the event decode are real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    decodeFunctionData,
    encodeAbiParameters,
    encodeEventTopics,
    type AbiParameter,
    type Address,
    type Hex,
} from 'viem';
import type { SmartAccount } from 'viem/account-abstraction';

vi.mock('../account/smartAccount.js', () => ({
    sendTransaction: vi.fn(),
    getBundlerClient: vi.fn(() => ({})),
}));

vi.mock('viem/actions', async (importOriginal) => ({
    ...(await importOriginal<typeof import('viem/actions')>()),
    getTransactionReceipt: vi.fn(),
}));

vi.mock('../api/index.js', () => ({ restCall: vi.fn() }));

import { sendTransaction } from '../account/smartAccount.js';
import { getTransactionReceipt } from 'viem/actions';
import { restCall } from '../api/index.js';
import { PERMISSIONS_MANAGER_ADDRESS } from '../constants.js';
import type { Chain } from '../store/index.js';
import {
    checkGrantPermissionsParams,
    grantPermissions,
    normalizePermissionNote,
    SPEND_PERMISSIONS_MANAGER_ABI,
} from './permissions.js';

const ACCOUNT: Address = '0x1111111111111111111111111111111111111111';
const SPENDER: Address = '0x2222222222222222222222222222222222222222';
const TARGET: Address = '0x3333333333333333333333333333333333333333';
const PERMISSION_HASH: Hex = '0xabababababababababababababababababababababababababababababababab';

const smartAccount = { address: ACCOUNT } as SmartAccount;
const chain = { id: 84532 } as Chain;
const calls = [{ target: TARGET, functionSignature: 'transfer(address,uint256)' }];

const [approvedEvent] = SPEND_PERMISSIONS_MANAGER_ABI.filter(
    (item) => item.type === 'event' && item.name === 'PermissionApproved'
);

function approvedPermission() {
    const approve = vi.mocked(sendTransaction).mock.calls.at(-1)?.[1].at(-1);
    if (!approve?.data) throw new Error('no approve call was sent');
    const decoded = decodeFunctionData({ abi: SPEND_PERMISSIONS_MANAGER_ABI, data: approve.data });
    if (decoded.functionName !== 'approve') throw new Error(`expected approve, got ${decoded.functionName}`);
    return decoded.args[0];
}

beforeEach(() => {
    vi.mocked(sendTransaction).mockReset().mockResolvedValue('0xfeed');
    vi.mocked(restCall).mockReset().mockResolvedValue(undefined);
    vi.mocked(getTransactionReceipt)
        .mockReset()
        .mockImplementation(async () => {
            const nonIndexed = approvedEvent.inputs.filter((input) => !('indexed' in input && input.indexed));
            return {
                logs: [
                    {
                        address: PERMISSIONS_MANAGER_ADDRESS,
                        topics: encodeEventTopics({
                            abi: [approvedEvent],
                            eventName: 'PermissionApproved',
                            args: { permissionHash: PERMISSION_HASH },
                        }),
                        data: encodeAbiParameters(nonIndexed as readonly AbiParameter[], [approvedPermission()]),
                    },
                ],
            } as never;
        });
});

function grant(note?: unknown) {
    return grantPermissions(
        smartAccount,
        2000000000,
        SPENDER,
        { calls, spends: [] },
        chain,
        undefined,
        undefined,
        undefined,
        undefined,
        {
            note: note as string | undefined,
        }
    );
}

function relayBody() {
    return vi.mocked(restCall).mock.calls[0][2] as Record<string, unknown>;
}

const params = (note: unknown) => [{ expiry: 2000000000, spender: SPENDER, permissions: { calls }, note }];

const BAD_NOTES: Array<[string, unknown]> = [
    ['201 characters', 'a'.repeat(201)],
    // Counted in UTF-16 code units, as the relay counts it: an emoji is two.
    ['101 emoji (202 code units)', '\u{1F680}'.repeat(101)],
    ['a zero-width space', 'Daily\u200BDCA'],
    ['a right-to-left override', 'Daily \u202EDCA'],
    ['a newline', 'Daily\nDCA'],
    ['a tab', 'Daily\tDCA'],
    ['a byte order mark', '\uFEFFDaily DCA'],
    // Shown as a line break, or not shown at all, so they hide or split text the same way.
    ['a line separator', 'Daily\u2028DCA'],
    ['a paragraph separator', 'Daily\u2029DCA'],
    ['a soft hyphen', 'Daily\u00ADDCA'],
    ['an Arabic letter mark', 'Daily\u061CDCA'],
    ['a Mongolian vowel separator', 'Daily\u180EDCA'],
    ['an interlinear annotation', 'Daily\uFFF9DCA'],
    // Invisible to a person, read by an agent: the usual way to hide an instruction.
    ['a tag character', 'Daily DCA\u{E0041}\u{E0042}'],
    // Half of a character, as `.slice(0, 200)` leaves when it cuts an emoji: the relay cannot
    // store it, and the grant has landed by then.
    ['an unpaired high surrogate', 'Daily DCA \uD83D'],
    ['an unpaired low surrogate', '\uDE80 Daily DCA'],
    // Variation selectors carry bytes behind a visible character without changing how it looks.
    ['a variation selector', 'Daily DCA\uFE00'],
    ['a run of emoji selectors', 'Daily DCA \u{1F680}\uFE0F\uFE0F'],
    ['a supplementary variation selector', 'Daily DCA\u{E0100}'],
    // Characters that render as blank space.
    ['a combining grapheme joiner', 'Daily\u034FDCA'],
    ['a Hangul filler', 'Daily\u3164DCA'],
    ['a halfwidth Hangul filler', 'Daily\uFFA0DCA'],
    ['a Hangul choseong filler', 'Daily\u115FDCA'],
    ['a Hangul jungseong filler', 'Daily\u1160DCA'],
    ['a Khmer inherent vowel', 'Daily\u17B4DCA'],
    ['a blank Braille pattern', 'Daily\u2800DCA'],
    ['a number', 42],
    ['an object', { text: 'Daily DCA' }],
];

describe('a note on wallet_grantPermissions, before any popup or dialog opens', () => {
    it.each(BAD_NOTES)('refuses a note with %s as invalid params', (_, note) => {
        expect(() => checkGrantPermissionsParams(params(note))).toThrow(
            expect.objectContaining({ code: -32602, message: expect.stringContaining('note') })
        );
    });

    it.each([
        ['200 characters', 'a'.repeat(200)],
        ['200 characters once its spaces are trimmed', `  ${'a'.repeat(200)}  `],
        ['100 emoji (200 code units)', '\u{1F680}'.repeat(100)],
        // One emoji selector, a keycap: how these characters are normally written.
        ['a red heart, with its emoji selector', 'Love it \u2764\uFE0F'],
        ['a keycap', 'Step \u0031\uFE0F\u20E3'],
        ['no note', undefined],
        ['an empty note', ''],
        ['a null note', null],
    ])('accepts %s', (_, note) => {
        expect(() => checkGrantPermissionsParams(params(note))).not.toThrow();
    });
});

describe('the note a host shows and stores', () => {
    it('drops ordinary spaces around it and keeps the rest as sent', () => {
        expect(normalizePermissionNote('  Daily DCA into ETH  ')).toBe('Daily DCA into ETH');
    });

    it.each([[''], ['   '], [undefined], [null]])('is no note at all for %j', (note) => {
        expect(normalizePermissionNote(note)).toBeUndefined();
    });

    // A dapp chooses the note, so a long run of spaces must not stall the screen before it is
    // refused for its length.
    it('refuses a note padded with 200,000 spaces at once', () => {
        const started = performance.now();

        expect(() => normalizePermissionNote(`a${' '.repeat(200_000)}a`)).toThrow(
            expect.objectContaining({ code: -32602 })
        );
        expect(performance.now() - started).toBeLessThan(500);
    });
});

describe('a note on Grant', () => {
    it('reaches the relay and the response as the app sent it, trimmed', async () => {
        const response = await grant('  Daily DCA into ETH  ');

        expect(relayBody().note).toBe('Daily DCA into ETH');
        expect(response.note).toBe('Daily DCA into ETH');
    });

    it('is not part of what gets approved on chain', async () => {
        // The salt is random and the start is now; pinned, the same grant sends the same bytes.
        vi.spyOn(Math, 'random').mockReturnValue(0.5);
        vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
        const approveCalldata = () => vi.mocked(sendTransaction).mock.calls.at(-1)?.[1].at(-1)?.data;
        try {
            await grant('Daily DCA into ETH');
            const withNote = approveCalldata();

            await grant(undefined);
            const withoutNote = approveCalldata();

            expect(withNote).toMatch(/^0x[0-9a-f]+$/);
            expect(withNote).toBe(withoutNote);
        } finally {
            vi.restoreAllMocks();
        }
    });

    it('leaves the note out of the relay body and the response when the app sends none', async () => {
        const response = await grant(undefined);

        expect(relayBody()).not.toHaveProperty('note');
        expect(response).not.toHaveProperty('note');
    });

    it('leaves the note out when the app sends only spaces', async () => {
        const response = await grant('   ');

        expect(relayBody()).not.toHaveProperty('note');
        expect(response).not.toHaveProperty('note');
    });

    it.each(BAD_NOTES)(
        'refuses a note with %s with nothing sent to the bundler, for an SDK that skipped the first check',
        async (_, note) => {
            await expect(grant(note)).rejects.toMatchObject({ code: -32602 });
            expect(sendTransaction).not.toHaveBeenCalled();
            expect(restCall).not.toHaveBeenCalled();
        }
    );
});
