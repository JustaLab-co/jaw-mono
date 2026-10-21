import { randomBytes } from 'node:crypto';

export const randomToken = () => randomBytes(16).toString('base64url');
