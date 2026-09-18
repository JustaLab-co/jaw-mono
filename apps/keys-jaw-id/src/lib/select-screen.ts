import { SDKRequestType } from './sdk-types';

/**
 * Which screen the dialog shows, derived in ONE place.
 *
 * The decision used to be spread across five near-identical render conditions
 * plus four trailing `state` checks, each handler assigning `state` for itself.
 * Nothing kept them agreeing, so a screen could contradict the data behind it —
 * a signing modal whose account had already been cleared, or a blank page with a
 * request pending. Every bug in the cold-start work was two of those inputs
 * disagreeing.
 */

/**
 * Where the flow is. Deliberately shares no member with `Screen`: when the two
 * overlapped, half of this function was the identity mapping and a reader had to
 * hold both vocabularies at once.
 */
export type Phase =
  | 'starting'
  | 'reading-passkeys'
  | 'creating-passkey'
  | 'choosing-account'
  | 'confirming-account'
  | 'working'
  | 'done'
  | 'failed';

/** What the dialog renders. One of these, always. */
export type Screen =
  /** A modal for the pending request; the request's own type picks which. */
  | { kind: 'modal' }
  | { kind: 'unsupported' }
  | { kind: 'loading' }
  /** Named for what is on screen, never for the phase — the two unions must not
   *  share a member, or the mapping reads as identity and both vocabularies
   *  have to be held at once. */
  | { kind: 'progress' }
  | { kind: 'receipt' }
  | { kind: 'failure' }
  /** Sign-in / account selection — the default when nothing else claims it. */
  | { kind: 'onboarding' };

export interface SelectScreenInput {
  /** Type of the in-flight request, or undefined when none is pending. */
  requestType: SDKRequestType | undefined;
  phase: Phase;
  /**
   * Whether this origin is authenticated: `authQuery.isAuthenticated`, which
   * useAuth derives from the session manager. This is called from a render body
   * and the session-manager read is async, so the query value is the source —
   * what keeps it honest is the awaited refetch in the cold-start handshake
   * handler, which lands before that handler clears the screen state.
   */
  isAuthenticated: boolean;
}

/**
 * Request types answered by a modal.
 *
 * ADD_FUNDS signs nothing, but it is still a modal request: it puts a screen up
 * and stays there until the user is done, which is the same shape the others
 * have.
 */
const MODAL_REQUESTS: ReadonlySet<SDKRequestType> = new Set([
  SDKRequestType.SIGN_MESSAGE,
  SDKRequestType.SIGN_TYPED_DATA,
  SDKRequestType.SEND_TRANSACTION,
  SDKRequestType.GRANT_PERMISSIONS,
  SDKRequestType.REVOKE_PERMISSIONS,
  SDKRequestType.ADD_FUNDS,
]);

/** Phases where the flow has finished; its modal must not come back. */
const TERMINAL: ReadonlySet<Phase> = new Set<Phase>(['done', 'failed']);

export function selectScreen({ requestType, phase, isAuthenticated }: SelectScreenInput): Screen {
  if (requestType && MODAL_REQUESTS.has(requestType) && !TERMINAL.has(phase)) {
    // `working` also passes: once the user has confirmed, the modal owns the
    // screen and shows its own progress, even though auth may have been rotated
    // away underneath it mid-flow.
    if (isAuthenticated || phase === 'working') return { kind: 'modal' };
  }

  if (requestType === SDKRequestType.UNSUPPORTED_METHOD) return { kind: 'unsupported' };

  switch (phase) {
    case 'starting':
    case 'reading-passkeys':
      return { kind: 'loading' };
    case 'working':
      return { kind: 'progress' };
    case 'done':
      return { kind: 'receipt' };
    case 'failed':
      return { kind: 'failure' };
    default:
      return { kind: 'onboarding' };
  }
}
