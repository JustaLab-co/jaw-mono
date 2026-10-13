---- MODULE FloatLock ----
(* The cross-replica float lock that serializes every turn that reads and moves
   one connection's money, and what a turn does when its lock session drops.

   Follows apps/mcp/src:
     payments/float-lock.ts 43-120  withFloat/hold: own postgres session,
                                    pg_advisory_xact_lock (106), lock_timeout
                                    (101), onclose sets lost unless released
                                    (86-88), held()/assertHeld() (109-112),
                                    session.end frees the lock (117-118)
     payments/float-lock.ts 151-157 tryLockFloat
     payments/refill.ts 94-138      guarded: writeTopUpAhead tx before the send (109),
                                    assertHeld (116), send (117), subtract on a
                                    thrown send (119)
     payments/refill.ts 172-262     refillHook: live check (181-189), caps read
                                    and check (194-209), assertHeld (213),
                                    held() after money moved (245-246), reserve
                                    and recordTopUp tx (250-253), catch returns
                                    funded (256-257)
     payments/store.ts              reserve 200, addTopUp 221, recordTopUp 211,
                                    writeTopUpAhead 233 (only while the
                                    connection is active, under a share lock on
                                    its row), topUpInFlight 249 (under an update
                                    lock on it), entriesFor 359
     connections/disconnect.ts 159-361  disconnect: topUpInFlight (164),
                                    returnFunds, assertHeld (339), sender.send
                                    (340), endConnection (167)
     connections/rows.ts 157-180    revokeByGrant: tryLockFloat poll; past its
                                    deadline it ends without the lock (170-173),
                                    never while a top-up is in flight (171)
     connections/rows.ts 198-215    endConnection refuses while a top-up is in
                                    flight (206)
     tools/connections.ts 170       revoke: withFloat + endConnection, the same
                                    shape as a disconnect with nothing to send
     tools/send.ts 55-95            jaw_transfer: assertHeld then send; it moves
                                    no float the caps read, so it is not a thread

   Assumptions:
   - Each turn runs on its own replica, so inTurn/queuedWithin and the per
     replica session slots never serialize two of them.
   - lockOwner is the Postgres side of the advisory lock. A Drop step is the
     server ending the session (network, idle timeout): the lock is free at
     once. Notify is the client's onclose arriving later, or never: neither
     step has fairness. A drop while waiting fails the lock query (busyOr
     rethrows), so that turn ends with an error.
   - hold.tx runs on the app pool, so a turn whose lock dropped still writes.
   - The caps check is Committed + Price <= Cap, where Committed counts rows
     whose price the caps read sees: a reservation (reserve) or a signed row
     (markSigned, after the turn). Each refill has one price; a top-up is one
     unit when the payer is short, else nothing is sent (the skip branch).
   - Reads under the lock (live 181, holding rows 194, caps 196) are one step.
   - A top-up is in flight from its write-ahead until its turn reserves or its
     call ends (store.ts topUpInFlight: amount written, reserved null, lease
     live). The write-ahead and an end both lock the connection row, so each
     is one step and they never interleave.
   - Past its deadline revokeByGrant still waits out a top-up in flight; the
     lease of the call that wrote it bounds that wait.
   - A Disconnect either sends its batch (revokes the grant on chain, sweeps)
     and ends the connection, or ends it with nothing sent (302, or the budget
     left to the owner at 336, which revokes nothing).
   - A refill top-up after the grant is revoked on chain moves nothing.
   - LostReply: the bundler took the top-up but the request threw, so the money
     lands while guarded subtracts the topUp row (119) and ensurePayerFunds
     returns a plain failure with no amount. TxFault: the reserve tx (250)
     fails, so the catch (256) runs.
   - Fairness: weak fairness on each thread's steps, which include the
     lock_timeout give-up, so a waiter cannot starve on its own. *)
EXTENDS Naturals, FiniteSets

CONSTANTS Refills, Discs, Revokes, Cap, Price, MaxDrops, LostReply, TxFault

None == "none"
Holders == Refills \cup Discs
Threads == Holders \cup Revokes

VARIABLES pc, funded, outcome,
          lockOwner, sess, lost, drops,
          live, topUp, visible,
          revokedOnChain, moved, lateSend

turn == <<pc, funded, outcome>>
lock == <<lockOwner, sess, lost, drops>>
db == <<live, topUp, visible>>
chain == <<revokedOnChain, moved, lateSend>>
vars == <<turn, lock, db, chain>>

Failed == {"refused", "busy", "error", "funding_failed"}
Outcomes == {"none", "ok"} \cup Failed
Committed == Cardinality({r \in Refills : visible[r]}) * Price
InFlight == \E r \in Refills : topUp[r] = 1 /\ ~visible[r] /\ pc[r] # "done"

Init == /\ pc = [t \in Threads |-> IF t \in Revokes THEN "poll" ELSE "wait"]
        /\ funded = [r \in Refills |-> FALSE]
        /\ outcome = [t \in Threads |-> "none"]
        /\ lockOwner = None
        /\ sess = [t \in Holders |-> "open"]
        /\ lost = [t \in Holders |-> FALSE]
        /\ drops = 0
        /\ live = TRUE
        /\ topUp = [r \in Refills |-> 0]
        /\ visible = [r \in Refills |-> FALSE]
        /\ revokedOnChain = FALSE
        /\ moved = [r \in Refills |-> FALSE]
        /\ lateSend = FALSE

Go(t, p) == pc' = [pc EXCEPT ![t] = p]
Say(t, o) == outcome' = [outcome EXCEPT ![t] = o]
\* Leaving the work of withFloat with an outcome: the finally block ends the session.
Leave(t, o) == Go(t, "finally") /\ Say(t, o)

\* Ending the session frees the lock (float-lock.ts:118); the wait is bounded
\* by lock_timeout (float-lock.ts:101).
Free(t) == IF lockOwner = t THEN None ELSE lockOwner
GiveUp(t) == /\ pc[t] = "wait"
             /\ sess[t] = "open"
             /\ Leave(t, "busy")
             /\ UNCHANGED <<funded, lock, db, chain>>

\* pg_advisory_xact_lock (float-lock.ts:106).
Acquire(t) == /\ pc[t] = "wait"
              /\ sess[t] = "open"
              /\ lockOwner = None
              /\ lockOwner' = t
              /\ Go(t, IF t \in Refills THEN "check" ELSE "read")
              /\ UNCHANGED <<funded, outcome, sess, lost, drops, db, chain>>

\* The lock query fails on a dropped session (float-lock.ts:106, busyOr).
WaitBroken(t) == /\ pc[t] = "wait"
                 /\ sess[t] # "open"
                 /\ Leave(t, "error")
                 /\ UNCHANGED <<funded, lock, db, chain>>

\* finally: released = true, session.end (float-lock.ts:117-118). A pending
\* onclose is swallowed: released is already set.
Finally(t) == /\ pc[t] = "finally"
              /\ lockOwner' = Free(t)
              /\ sess' = [sess EXCEPT ![t] = "ended"]
              /\ Go(t, IF t \in Refills /\ outcome[t] = "ok" THEN "sign" ELSE "done")
              /\ UNCHANGED <<funded, outcome, lost, drops, db, chain>>

(* Refill turn, refill.ts *)

\* live check and caps read and check (181-209).
Check(r) == /\ pc[r] = "check"
            /\ IF ~live \/ Committed + Price > Cap
                 THEN Leave(r, "refused")
                 ELSE Go(r, "assert212") /\ UNCHANGED outcome
            /\ UNCHANGED <<funded, lock, db, chain>>

\* hold.assertHeld() (213), then ensurePayerFunds sends only when the payer is short.
Assert212(r) == /\ pc[r] = "assert212"
                /\ IF lost[r]
                     THEN Leave(r, "error")
                     ELSE (Go(r, "addTopUp") \/ Go(r, "skip")) /\ UNCHANGED outcome
                /\ UNCHANGED <<funded, lock, db, chain>>

\* writeTopUpAhead in its own tx before the send (109, store.ts:233): on an
\* ended connection it throws, failedBeforeSend, and the turn ends in error.
AddTopUp(r) == /\ pc[r] = "addTopUp"
               /\ IF live
                    THEN /\ topUp' = [topUp EXCEPT ![r] = 1]
                         /\ Go(r, "assert115")
                         /\ UNCHANGED outcome
                    ELSE /\ Leave(r, "error")
                         /\ UNCHANGED topUp
               /\ UNCHANGED <<funded, lock, live, visible, chain>>

\* hold.assertHeld() right before the send (116); FloatLost lands in the catch
\* that subtracts the top-up (119) and ensurePayerFunds returns a failure.
Assert115(r) == /\ pc[r] = "assert115"
                /\ IF lost[r]
                     THEN /\ topUp' = [topUp EXCEPT ![r] = 0]
                          /\ Leave(r, "refused")
                     ELSE /\ Go(r, "send")
                          /\ UNCHANGED <<topUp, outcome>>
                /\ UNCHANGED <<funded, lock, live, visible, chain>>

Land(r) == /\ moved' = [moved EXCEPT ![r] = TRUE]
           /\ lateSend' = (lateSend \/ ~live)

\* executor.request('wallet_sendCalls') (117).
Send(r) == /\ pc[r] = "send"
           /\ \/ /\ ~revokedOnChain
                 /\ Land(r)
                 /\ Go(r, "held")
                 /\ UNCHANGED <<outcome, topUp>>
              \/ /\ topUp' = [topUp EXCEPT ![r] = 0]
                 /\ Leave(r, "refused")
                 /\ UNCHANGED <<moved, lateSend>>
              \/ /\ LostReply
                 /\ ~revokedOnChain
                 /\ Land(r)
                 /\ topUp' = [topUp EXCEPT ![r] = 0]
                 /\ Leave(r, "refused")
           /\ UNCHANGED <<funded, lock, live, visible, revokedOnChain>>

\* Money moved: funded is the caller's outcome from here on (246).
Held(r) == /\ pc[r] = "held"
           /\ funded' = [funded EXCEPT ![r] = TRUE]
           /\ Say(r, IF lost[r] THEN "funding_failed" ELSE "ok")
           /\ Go(r, "reserve")
           /\ UNCHANGED <<lock, db, chain>>

\* No money moved: the reservation commits under the lock or not at all (245).
Skip(r) == /\ pc[r] = "skip"
           /\ IF lost[r]
                THEN Leave(r, "error")
                ELSE Go(r, "reserve") /\ UNCHANGED outcome
           /\ UNCHANGED <<funded, lock, db, chain>>

\* reserve and recordTopUp in one tx (250-253); a failed tx lands in the catch
\* (256-258), which returns funded when money moved.
Reserve(r) == /\ pc[r] = "reserve"
              /\ \/ /\ ~funded[r]
                    /\ visible' = [visible EXCEPT ![r] = TRUE]
                    /\ Say(r, "ok")
                 \/ /\ funded[r]
                    /\ visible' = IF outcome[r] = "ok" THEN [visible EXCEPT ![r] = TRUE] ELSE visible
                    /\ UNCHANGED outcome
                 \/ /\ TxFault
                    /\ outcome' = IF funded[r] THEN outcome ELSE [outcome EXCEPT ![r] = "error"]
                    /\ UNCHANGED visible
              /\ Go(r, "finally")
              /\ UNCHANGED <<funded, lock, live, topUp, chain>>

\* After the turn the caller signs: markSigned makes the price count (store.ts:154).
Sign(r) == /\ pc[r] = "sign"
           /\ visible' = [visible EXCEPT ![r] = TRUE]
           /\ Go(r, "done")
           /\ UNCHANGED <<funded, outcome, lock, live, topUp, chain>>

(* Disconnect turn, disconnect.ts *)

\* A top-up in flight refuses first (164). Then returnFunds reads (236-295): a
\* batch to send, or nothing sent (302, 336).
Read(d) == /\ pc[d] = "read"
           /\ IF InFlight
                THEN Leave(d, "busy")
                ELSE (Go(d, "assert335") \/ Go(d, "end")) /\ UNCHANGED outcome
           /\ UNCHANGED <<funded, lock, db, chain>>

Assert335(d) == /\ pc[d] = "assert335"
                /\ IF lost[d]
                     THEN Leave(d, "error")
                     ELSE Go(d, "sweep") /\ UNCHANGED outcome
                /\ UNCHANGED <<funded, lock, db, chain>>

\* sender.send (340): the batch revokes the grant and sweeps, or nothing lands.
Sweep(d) == /\ pc[d] = "sweep"
            /\ \/ /\ revokedOnChain' = TRUE
                  /\ Go(d, "end")
                  /\ UNCHANGED outcome
               \/ /\ Leave(d, "refused")
                  /\ UNCHANGED revokedOnChain
            /\ UNCHANGED <<funded, lock, db, moved, lateSend>>

\* endConnection (167, rows.ts:198).
End(d) == /\ pc[d] = "end"
          /\ ~InFlight
          /\ live' = FALSE
          /\ Leave(d, "ok")
          /\ UNCHANGED <<funded, lock, topUp, visible, chain>>

\* It throws TopUpInFlight while a top-up may still land (rows.ts:206).
EndBusy(d) == /\ pc[d] = "end"
              /\ InFlight
              /\ Leave(d, "busy")
              /\ UNCHANGED <<funded, lock, db, chain>>

(* revokeByGrant, rows.ts:157-180 *)

\* tryLockFloat, topUpInFlight and the end in one tx (168-174).
TryLock(v) == /\ pc[v] = "poll"
              /\ lockOwner = None
              /\ ~InFlight
              /\ live' = FALSE
              /\ Go(v, "done")
              /\ Say(v, "ok")
              /\ UNCHANGED <<funded, lock, topUp, visible, chain>>

\* Past the deadline it ends the connection without the lock (170-173).
Deadline(v) == /\ pc[v] = "poll"
               /\ lockOwner # None
               /\ ~InFlight
               /\ live' = FALSE
               /\ Go(v, "done")
               /\ Say(v, "ok")
               /\ UNCHANGED <<funded, lock, topUp, visible, chain>>

(* Environment *)

\* The server ends a lock session: the lock is free at once.
Drop(t) == /\ drops < MaxDrops
           /\ sess[t] = "open"
           /\ pc[t] \notin {"sign", "done"}
           /\ sess' = [sess EXCEPT ![t] = "dropped"]
           /\ lockOwner' = Free(t)
           /\ drops' = drops + 1
           /\ UNCHANGED <<turn, lost, db, chain>>

\* onclose reaches the holder (float-lock.ts:86-88).
Notify(t) == /\ sess[t] = "dropped"
             /\ sess' = [sess EXCEPT ![t] = "closed"]
             /\ lost' = [lost EXCEPT ![t] = TRUE]
             /\ UNCHANGED <<turn, lockOwner, drops, db, chain>>

RefillStep(r) == Acquire(r) \/ GiveUp(r) \/ WaitBroken(r) \/ Check(r) \/ Assert212(r)
                 \/ AddTopUp(r) \/ Assert115(r) \/ Send(r) \/ Held(r) \/ Skip(r)
                 \/ Reserve(r) \/ Finally(r) \/ Sign(r)
DiscStep(d) == Acquire(d) \/ GiveUp(d) \/ WaitBroken(d) \/ Read(d) \/ Assert335(d)
               \/ Sweep(d) \/ End(d) \/ EndBusy(d) \/ Finally(d)
Step(t) == IF t \in Refills THEN RefillStep(t)
           ELSE IF t \in Discs THEN DiscStep(t)
           ELSE TryLock(t) \/ Deadline(t)

Terminated == \A t \in Threads : pc[t] = "done"
Done == Terminated /\ UNCHANGED vars

Next == \/ \E t \in Threads : Step(t)
        \/ \E t \in Holders : Drop(t) \/ Notify(t)
        \/ Done

Spec == Init /\ [][Next]_vars /\ \A t \in Threads : WF_vars(Step(t))

(* Properties *)

TypeOK == /\ pc \in [Threads -> {"wait", "poll", "check", "assert212", "addTopUp", "assert115",
                                  "send", "held", "skip", "reserve", "read", "assert335",
                                  "sweep", "end", "finally", "sign", "done"}]
          /\ funded \in [Refills -> BOOLEAN]
          /\ outcome \in [Threads -> Outcomes]
          /\ lockOwner \in Holders \cup {None}
          /\ sess \in [Holders -> {"open", "dropped", "closed", "ended"}]
          /\ lost \in [Holders -> BOOLEAN]
          /\ drops \in 0..MaxDrops
          /\ live \in BOOLEAN
          /\ topUp \in [Refills -> 0..1]
          /\ visible \in [Refills -> BOOLEAN]
          /\ revokedOnChain \in BOOLEAN
          /\ moved \in [Refills -> BOOLEAN]
          /\ lateSend \in BOOLEAN

\* (a) The prices of turns that return ok never pass the cap checkCaps enforces.
CapHolds == Cardinality({r \in Refills : outcome[r] = "ok"}) * Price <= Cap

\* (b) Money that landed has its topUpAmount on the row, or its turn reports failure.
MovedRecorded == \A r \in Refills : moved[r] /\ topUp[r] = 0 => outcome[r] \in Failed

\* (c) No top-up lands once the connection is no longer live.
NoSendAfterEnd == ~lateSend

\* (d) A turn that moved money returns a funded outcome to its caller.
MovedReachesCaller == \A r \in Refills :
                        moved[r] /\ pc[r] \in {"sign", "done"} => outcome[r] \in {"ok", "funding_failed"}

\* (e) Every turn waiting on the lock gets it or gives up.
Waiting(t) == pc[t] \in {"wait", "poll"}
WaitEnds == \A t \in Threads : Waiting(t) ~> ~Waiting(t)

(* Reachable states the properties depend on *)

\* A waiter parked behind a holder.
ParkedWaiter == \E t \in Holders : pc[t] = "wait" /\ lockOwner \notin {None, t}
\* A turn inside its critical section, not told of its drop, while another holds the lock.
LockStolen == \E t \in Holders : /\ pc[t] \notin {"wait", "finally", "sign", "done"}
                                 /\ ~lost[t]
                                 /\ lockOwner \notin {None, t}
\* A turn told of its drop before it reached a check.
LostSeen == \E t \in Holders : lost[t] /\ pc[t] \in {"assert212", "assert115", "assert335", "skip"}
\* The connection ended.
Ended == ~live
====
