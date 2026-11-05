'use client';

import { useParams } from 'next/navigation';
import { GuardianPage } from '../../../../components/GuardianPage';

/**
 * The page a recovery request's guardians open: `<approveUrl>/<requestId>`, the SDK's default
 * guardian link. A full page, never framed: the middleware keeps `frame-ancestors 'none'` on every
 * route but `/`.
 *
 * No dApp hands this page a key, so it approves under keys' own (`NEXT_PUBLIC_RECOVERY_API_KEY`).
 */
export default function GuardianApprovePage() {
  const { requestId } = useParams<{ requestId: string }>();
  return <GuardianPage requestId={requestId} apiKey={process.env.NEXT_PUBLIC_RECOVERY_API_KEY || undefined} />;
}
