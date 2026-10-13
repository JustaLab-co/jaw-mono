---- MODULE FloatLock ----
(* The cross-replica float lock that serializes every turn that reads and moves
   one connection's money, and what a turn does when its lock session drops.

   Follows apps/mcp/src:
     payments/float-lock.ts 48-143  withFloat/hold: own postgres session,
                                    pg_advisory_xact_lock (113), lock_timeout
                                    (108), fence bump (114-120), onclose sets
                                    lost unless released (93-95),
                                    held()/assertHeld() (123-126), owns()
                                    (127-135), session.end frees the lock
                                    (140-141)
     payments/float-lock.ts 174-180 tryLockFloat
     payments/refill.ts 93-137      guarded: addTopUp tx before the send (108),
                                    assertHeld (115), send (116), subtract on a
                                    thrown send (118)
     payments/refill.ts 171-261     refillHook: live check (180-188), caps read
                                    and check (193-208), assertHeld (212),
                                    held() after money moved (245-246), owns()
                                    then reserve and recordTopUp tx (251-260),
                                    catch returns funded (262-263)
     payments/store.ts              reserve 200, addTopUp 221, recordTopUp 211,
                                    entriesFor 320 (what the caps read counts)
     connections/disconnect.ts 157-357  disconnect: returnFunds, assertHeld
                                    (335), sender.send (336), endConnection (164)
     connections/rows.ts 155-178    revokeByGrant: tryLockFloat poll, then end
                                    without the lock past its deadline (175-176)
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
   - fence is connections.float_fence. Acquire takes the lock and bumps it in
     one step: in the code the bump waits on the row owns() locks, and the
     next turn reads the caps only after its bump, so a reserve tx that passed
     owns() commits before that read.
   - The caps check is Committed + Price <= Cap, where Committed counts rows
     whose price the caps read sees: a reservation (reserve) or a signed row
     (markSigned, after the turn). Each refill has one price; a top-up is one
     unit when the payer is short, else nothing is sent (the skip branch).
   - Reads under the lock (live 180, holding rows 193, caps 195) are one step.
   - A Disconnect either sends its batch (revokes the grant on chain, sweeps)
     and ends the connection, or ends it with nothing sent (298, or the budget
     left to the owner at 332, which revokes nothing).
   - A refill top-up after the grant is revoked on chain moves nothing.
   - LostReply: the bundler took the top-up but the request threw, so the money
     lands while guarded subtracts the topUp row (118) and ensurePayerFunds
     returns a plain failure with no amount. TxFault: the reserve tx (249)
     fails, so the catch (255) runs.
   - Fairness: weak fairness on each thread's steps, which include the
     lock_timeout give-up, so a waiter cannot starve on its own. *)
EXTENDS Naturals, FiniteSets

CONSTANTS Refills, Discs, Revokes, Cap, Price, MaxDrops, LostReply, TxFault

None == "none"
Holders == Refills \cup Discs
Threads == Holders \cup Revokes

VARIABLES pc, funded, outcome,
          lockOwner, sess, lost, drops, fence, took,
          live, topUp, visible,
          revokedOnChain, moved, lateSend

turn == <<pc, funded, outcome>>
lock == <<lockOwner, sess, lost, drops, fence, took>>
db == <<live, topUp, visible>>
chain == <<revokedOnChain, moved, lateSend>>
vars == <<turn, lock, db, chain>>

Failed == {"refused", "busy", "error", "funding_failed"}
Outcomes == {"none", "ok", "funded"} \cup Failed
Committed == Cardinality({r \in Refills : visible[r]}) * Price

Init == /\ pc = [t \in Threads |-> IF t \in Revokes THEN "poll" ELSE "wait"]
        /\ funded = [r \in Refills |-> FALSE]
        /\ outcome = [t \in Threads |-> "none"]
        /\ lockOwner = None
        /\ sess = [t \in Holders |-> "open"]
        /\ lost = [t \in Holders |-> FALSE]
        /\ drops = 0
        /\ fence = 0
        /\ took = [t \in Holders |-> 0]
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

\* pg_advisory_xact_lock and the fence bump (float-lock.ts:113-120).
Acquire(t) == /\ pc[t] = "wait"
              /\ sess[t] = "open"
              /\ lockOwner = None
              /\ lockOwner' = t
              /\ fence' = fence + 1
              /\ took' = [took EXCEPT ![t] = fence + 1]
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
              /\ UNCHANGED <<funded, outcome, lost, drops, fence, took, db, chain>>

(* Refill turn, refill.ts *)

\* live check and caps read and check (180-208).
Check(r) == /\ pc[r] = "check"
            /\ IF ~live \/ Committed + Price > Cap
                 THEN Leave(r, "refused")
                 ELSE Go(r, "assert212") /\ UNCHANGED outcome
            /\ UNCHANGED <<funded, lock, db, chain>>

\* hold.assertHeld() (212), then ensurePayerFunds sends only when the payer is short.
Assert212(r) == /\ pc[r] = "assert212"
                /\ IF lost[r]
                     THEN Leave(r, "error")
                     ELSE (Go(r, "addTopUp") \/ Go(r, "skip")) /\ UNCHANGED outcome
                /\ UNCHANGED <<funded, lock, db, chain>>

\* addTopUp in its own tx before the send (108, store.ts:221).
AddTopUp(r) == /\ pc[r] = "addTopUp"
               /\ topUp' = [topUp EXCEPT ![r] = 1]
               /\ Go(r, "assert115")
               /\ UNCHANGED <<funded, outcome, lock, live, visible, chain>>

\* hold.assertHeld() right before the send (115); FloatLost lands in the catch
\* that subtracts the top-up (118) and ensurePayerFunds returns a failure.
Assert115(r) == /\ pc[r] = "assert115"
                /\ IF lost[r]
                     THEN /\ topUp' = [topUp EXCEPT ![r] = 0]
                          /\ Leave(r, "refused")
                     ELSE /\ Go(r, "send")
                          /\ UNCHANGED <<topUp, outcome>>
                /\ UNCHANGED <<funded, lock, live, visible, chain>>

Land(r) == /\ moved' = [moved EXCEPT ![r] = TRUE]
           /\ lateSend' = (lateSend \/ ~live)

\* executor.request('wallet_sendCalls') (116).
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

\* Money moved: funded is the caller's outcome from here on (246). "funded" is an
\* ok the turn holds but has not returned yet.
Held(r) == /\ pc[r] = "held"
           /\ funded' = [funded EXCEPT ![r] = TRUE]
           /\ Say(r, IF lost[r] THEN "funding_failed" ELSE "funded")
           /\ Go(r, "reserve")
           /\ UNCHANGED <<lock, db, chain>>

\* No money moved: the reservation commits under the lock or not at all (245).
Skip(r) == /\ pc[r] = "skip"
           /\ IF lost[r]
                THEN Leave(r, "error")
                ELSE Go(r, "reserve") /\ UNCHANGED outcome
           /\ UNCHANGED <<funded, lock, db, chain>>

\* owns() (float-lock.ts:127-135): no drop seen and no turn bumped the fence since.
Owns(r) == ~lost[r] /\ took[r] = fence

Returned(r) == IF outcome[r] = "funded" THEN "ok" ELSE outcome[r]

\* owns(), reserve and recordTopUp in one tx (251-260). Not owning reserves nothing:
\* FloatLost when no money moved, LOST when it did. A tx that fails, before owns()
\* or after it, lands in the catch (262-264), which returns funded when money moved.
Reserve(r) == /\ pc[r] = "reserve"
              /\ \/ /\ ~Owns(r)
                    /\ Say(r, IF funded[r] THEN "funding_failed" ELSE "error")
                    /\ UNCHANGED visible
                 \/ /\ Owns(r)
                    /\ ~funded[r]
                    /\ visible' = [visible EXCEPT ![r] = TRUE]
                    /\ Say(r, "ok")
                 \/ /\ Owns(r)
                    /\ funded[r]
                    /\ visible' = IF outcome[r] = "funded" THEN [visible EXCEPT ![r] = TRUE] ELSE visible
                    /\ Say(r, Returned(r))
                 \/ /\ TxFault
                    /\ Say(r, IF funded[r] THEN Returned(r) ELSE "error")
                    /\ UNCHANGED visible
              /\ Go(r, "finally")
              /\ UNCHANGED <<funded, lock, live, topUp, chain>>

\* After the turn the caller signs: markSigned makes the price count (store.ts:154).
Sign(r) == /\ pc[r] = "sign"
           /\ visible' = [visible EXCEPT ![r] = TRUE]
           /\ Go(r, "done")
           /\ UNCHANGED <<funded, outcome, lock, live, topUp, chain>>

(* Disconnect turn, disconnect.ts *)

\* returnFunds reads (232-291): a batch to send, or nothing sent (298, 332).
Read(d) == /\ pc[d] = "read"
           /\ (Go(d, "assert335") \/ Go(d, "end"))
           /\ UNCHANGED <<funded, outcome, lock, db, chain>>

Assert335(d) == /\ pc[d] = "assert335"
                /\ IF lost[d]
                     THEN Leave(d, "error")
                     ELSE Go(d, "sweep") /\ UNCHANGED outcome
                /\ UNCHANGED <<funded, lock, db, chain>>

\* sender.send (336): the batch revokes the grant and sweeps, or nothing lands.
Sweep(d) == /\ pc[d] = "sweep"
            /\ \/ /\ revokedOnChain' = TRUE
                  /\ Go(d, "end")
                  /\ UNCHANGED outcome
               \/ /\ Leave(d, "refused")
                  /\ UNCHANGED revokedOnChain
            /\ UNCHANGED <<funded, lock, db, moved, lateSend>>

\* endConnection (164, rows.ts:188).
End(d) == /\ pc[d] = "end"
          /\ live' = FALSE
          /\ Leave(d, "ok")
          /\ UNCHANGED <<funded, lock, topUp, visible, chain>>

(* revokeByGrant, rows.ts:155-178 *)

\* tryLockFloat and the end in one tx (167-171).
TryLock(v) == /\ pc[v] = "poll"
              /\ lockOwner = None
              /\ live' = FALSE
              /\ Go(v, "done")
              /\ Say(v, "ok")
              /\ UNCHANGED <<funded, lock, topUp, visible, chain>>

\* Past the deadline it ends the connection without the lock (175-176).
Deadline(v) == /\ pc[v] = "poll"
               /\ lockOwner # None
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
           /\ UNCHANGED <<turn, lost, fence, took, db, chain>>

\* onclose reaches the holder (float-lock.ts:86-88).
Notify(t) == /\ sess[t] = "dropped"
             /\ sess' = [sess EXCEPT ![t] = "closed"]
             /\ lost' = [lost EXCEPT ![t] = TRUE]
             /\ UNCHANGED <<turn, lockOwner, drops, fence, took, db, chain>>

RefillStep(r) == Acquire(r) \/ GiveUp(r) \/ WaitBroken(r) \/ Check(r) \/ Assert212(r)
                 \/ AddTopUp(r) \/ Assert115(r) \/ Send(r) \/ Held(r) \/ Skip(r)
                 \/ Reserve(r) \/ Finally(r) \/ Sign(r)
DiscStep(d) == Acquire(d) \/ GiveUp(d) \/ WaitBroken(d) \/ Read(d) \/ Assert335(d)
               \/ Sweep(d) \/ End(d) \/ Finally(d)
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
          /\ fence \in 0..Cardinality(Holders)
          /\ took \in [Holders -> 0..Cardinality(Holders)]
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
