/** The longest request id shown large, as a code to compare. */
export const MAX_REQUEST_CODE_LENGTH = 16;

const REQUEST_CODE = new RegExp(`^[A-Za-z0-9-]{1,${MAX_REQUEST_CODE_LENGTH}}$`);

/**
 * Whether a request id is shown as a code: letters, digits and hyphens only. viem accepts anything
 * to the end of the line, so without this a dApp could put a sentence such as "JAW VERIFIED" in
 * title type under the wallet's own label. Anything else is shown as a plain row.
 */
export const isRequestCode = (id: string): boolean => REQUEST_CODE.test(id);
