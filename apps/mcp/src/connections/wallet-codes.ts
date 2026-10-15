export const USER_REJECTED = 4001;

// The wallet returns these from wallet_sendCalls only before it builds the
// userOp (parameter checks, session and chain guards). Its dialog turns every
// failure after that into 4001, -32003 or -32603, and the bridge page reports
// anything without a code as -32000, so those stay "may have sent".
const BEFORE_SUBMIT = new Set([4100, 4200, 4900, 4901, 5700, 5710, -32602]);

export const refusedBeforeSubmit = (code: unknown) => typeof code === 'number' && BEFORE_SUBMIT.has(code);
