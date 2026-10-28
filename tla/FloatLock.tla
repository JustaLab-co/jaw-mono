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
     payments/refill.ts 94-142      guarded: owns() then writeTopUpAhead in one
                                    tx before the send (110-113), assertHeld (119),
                                    subtract on FloatLost (121), send (125),
                                    which keeps the amount on the row when it
                                    throws
     payments/refill.ts 177-279     refillHook: live check (186-194), caps read
                                    and check (199-214), assertHeld (218),
                                    held() after money moved (251-252), owns()
                                    then reserve and recordTopUp tx (257-266),
                                    catch refuses funded unreserved (268-275)
     payments/store.ts              reserve 200, addTopUp 221, recordTopUp 211,
                                    writeTopUpAhead 233 (only while the
                                    connection is active, under a share lock on
                                    its row), sendInFlight 259 (under an update
                                    lock on it), entriesFor 359
     connections/disconnect.ts 161-407  disconnect and sweepOnReuse, both
                                    through returnAndEnd (188-201):
                                    sendInFlight (191), returnFunds, assertHeld
                                    (385), sender.send (386), endConnection (194)
     connections/rows.ts 157-180    revokeByGrant: tryLockFloat poll; past its
                                    deadline it ends without the lock (170-173),
                                    never while a top-up is in flight (171)
     connections/rows.ts 198-215    endConnection refuses while a top-up is in
                                    flight (206)
     tools/connections.ts 170       revoke: withFloat + endConnection, the same
                                    shape as a disconnect with nothing to send
     tools/session-execute.ts 227-291  submitUnder: chainView under a 2 s
                                    bound, then the settle writes (231-237),
                                    owns() and the live check in one tx
                                    (238-241), heldSpends (247), fit reads the
                                    chain at the logged block (249), owns(),
                                    the live check and recordSend in one tx
                                    (263-278), assertHeld (282), send (284),
                                    noteSubmitted with no owns() (289); the
                                    receipt and its conclusion run after the
                                    lock (314-315)
     payments/store.ts 259          sendInFlight also counts an execute whose
                                    rows are open with no userOp hash yet and a
                                    live lease: recorded, not yet submitted

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
     owns() commits before that read. The same holds for the top-up write.
   - The caps check is Committed + Price <= Cap, where Committed counts rows
     whose price the caps read sees: a reservation (reserve) or a signed row
     (markSigned, after the turn). Each refill has one price; a top-up is one
     unit when the payer is short, else nothing is sent (the skip branch).
   - Reads under the lock (live 186, holding rows 199, caps 201) are one step.
   - A top-up is in flight from its write-ahead until its turn reserves or its
     call ends (store.ts sendInFlight: amount written, reserved null, lease
     live). The write-ahead and an end both lock the connection row, so each
     is one step and they never interleave.
   - Past its deadline revokeByGrant still waits out a top-up in flight; the
     lease of the call that wrote it bounds that wait.
   - A Disconnect either sends its batch (revokes the grant on chain, sweeps)
     and ends the connection, or ends it with nothing sent (348, or the budget
     left to the owner at 382, which revokes nothing).
   - A refill top-up after the grant is revoked on chain moves nothing.
   - LostReply: the bundler took the top-up but the request threw, so the money
     lands while ensurePayerFunds returns a plain failure with no amount, which
     the caller reads as funding_failed. TxFault: the reserve tx (257-266) fails,
     so the catch (268-275) runs.
   - An execute spends a custom grant, not the float, so it shares only the lock
     with the other turns. Each execute moves one unit of the grant's limit
     ExecCap. ExecSpent is what moved on chain and pend the runs heldSpends
     counts: fit refuses when the period spend plus pend plus 1 passes ExecCap,
     as fit.ts adds heldSpends to the period spend. The permission manager's own limit is left out, so
     ExecCapHolds checks the server's check alone.
   - A submitted userOp lands or reverts later, at any time (ExecLand). Its rows
     settle only from what the chain logged (ExecConclude): the receipt after
     the lock, settleLogged, or the reconciler, each guarded by state = 'open'.
   - Fit reads the chain at the block the settle read logged to, and a node behind
     it fails the read. A landed row counts as held unless that read saw it; the
     code drops landed rows from held ten minutes after they land, past any node's
     lag, which the model leaves out by holding them for good. Nothing reorgs. A run that was
     never seen in its block window is not released here, though the reconciler
     does release it (the third execute mutation shows what that costs).
   - Fairness: weak fairness on each thread's steps, which include the
     lock_timeout give-up, so a waiter cannot starve on its own. *)
EXTENDS Naturals, FiniteSets

CONSTANTS Refills, Discs, Revokes, Execs, Cap, Price, ExecCap, MaxDrops, LostReply, TxFault

None == "none"
Holders == Refills \cup Discs \cup Execs
Threads == Holders \cup Revokes

VARIABLES pc, funded, outcome,
          lockOwner, sess, lost, drops, fence, took,
          live, topUp, visible,
          revokedOnChain, moved, lateSend, staleTopUp,
          row, op, pend, seen, snap, pinned

turn == <<pc, funded, outcome>>
lock == <<lockOwner, sess, lost, drops, fence, took>>
db == <<live, topUp, visible>>
chain == <<revokedOnChain, moved, lateSend, staleTopUp>>
exec == <<row, op, pend, seen, snap, pinned>>
vars == <<turn, lock, db, chain, exec>>

Failed == {"refused", "busy", "error", "funding_failed"}
Outcomes == {"none", "ok", "funded"} \cup Failed
Committed == Cardinality({r \in Refills : visible[r]}) * Price
ExecInFlight == \E e \in Execs : row[e] = "open" /\ pc[e] \in {"assertExec", "submit"}
InFlight == (\E r \in Refills : topUp[r] = 1 /\ ~visible[r] /\ pc[r] # "done") \/ ExecInFlight
ExecSpent == Cardinality({e \in Execs : op[e] = "landed"})

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
        /\ staleTopUp = FALSE
        /\ row = [e \in Execs |-> "none"]
        /\ op = [e \in Execs |-> "none"]
        /\ pend = [e \in Execs |-> {}]
        /\ seen = [e \in Execs |-> {}]
        /\ snap = [e \in Execs |-> 0]
        /\ pinned = [e \in Execs |-> FALSE]

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
              /\ Go(t, IF t \in Refills THEN "check" ELSE IF t \in Execs THEN "settle" ELSE "read")
              /\ UNCHANGED <<funded, outcome, sess, lost, drops, db, chain>>

\* The lock query fails on a dropped session (float-lock.ts:106, busyOr).
WaitBroken(t) == /\ pc[t] = "wait"
                 /\ sess[t] # "open"
                 /\ Leave(t, "error")
                 /\ UNCHANGED <<funded, lock, db, chain>>

\* owns() (float-lock.ts:127-135): no drop seen and no turn bumped the fence since.
Owns(r) == ~lost[r] /\ took[r] = fence

\* finally: released = true, session.end (float-lock.ts:117-118). A pending
\* onclose is swallowed: released is already set.
Finally(t) == /\ pc[t] = "finally"
              /\ lockOwner' = Free(t)
              /\ sess' = [sess EXCEPT ![t] = "ended"]
              /\ Go(t, IF t \in Refills /\ outcome[t] = "ok" THEN "sign" ELSE "done")
              /\ UNCHANGED <<funded, outcome, lost, drops, fence, took, db, chain>>

(* Refill turn, refill.ts *)

\* live check and caps read and check (186-214).
Check(r) == /\ pc[r] = "check"
            /\ IF ~live \/ Committed + Price > Cap
                 THEN Leave(r, "refused")
                 ELSE Go(r, "assert212") /\ UNCHANGED outcome
            /\ UNCHANGED <<funded, lock, db, chain>>

\* hold.assertHeld() (218), then ensurePayerFunds sends only when the payer is short.
Assert212(r) == /\ pc[r] = "assert212"
                /\ IF lost[r]
                     THEN Leave(r, "error")
                     ELSE (Go(r, "addTopUp") \/ Go(r, "skip")) /\ UNCHANGED outcome
                /\ UNCHANGED <<funded, lock, db, chain>>

\* owns() then writeTopUpAhead in one tx before the send (110-113,
\* store.ts:233). Not owning throws FloatLost, and on an ended connection the
\* write-ahead throws: either way nothing is sent and the turn ends in error.
AddTopUp(r) == /\ pc[r] = "addTopUp"
               /\ IF Owns(r) /\ live
                    THEN /\ topUp' = [topUp EXCEPT ![r] = 1]
                         /\ Go(r, "assert115")
                         /\ UNCHANGED outcome
                    ELSE /\ Leave(r, "error")
                         /\ UNCHANGED topUp
               /\ staleTopUp' = (staleTopUp \/ (topUp'[r] = 1 /\ took[r] # fence))
               /\ UNCHANGED <<funded, lock, live, visible, revokedOnChain, moved, lateSend>>

\* hold.assertHeld() right before the send (119); FloatLost lands in the catch
\* that subtracts the top-up (121) and ensurePayerFunds returns a failure.
Assert115(r) == /\ pc[r] = "assert115"
                /\ IF lost[r]
                     THEN /\ topUp' = [topUp EXCEPT ![r] = 0]
                          /\ Leave(r, "refused")
                     ELSE /\ Go(r, "send")
                          /\ UNCHANGED <<topUp, outcome>>
                /\ UNCHANGED <<funded, lock, live, visible, chain>>

Land(r) == /\ moved' = [moved EXCEPT ![r] = TRUE]
           /\ lateSend' = (lateSend \/ ~live)

\* executor.request('wallet_sendCalls') (125). A send that throws keeps the
\* top-up on the row, whether or not the money landed.
Send(r) == /\ pc[r] = "send"
           /\ \/ /\ ~revokedOnChain
                 /\ Land(r)
                 /\ Go(r, "held")
                 /\ UNCHANGED outcome
              \/ /\ Leave(r, "funding_failed")
                 /\ UNCHANGED <<moved, lateSend>>
              \/ /\ LostReply
                 /\ ~revokedOnChain
                 /\ Land(r)
                 /\ Leave(r, "funding_failed")
           /\ UNCHANGED <<funded, lock, live, topUp, visible, revokedOnChain, staleTopUp>>

\* Money moved: funded is the caller's outcome from here on (252). "funded" is an
\* ok the turn holds but has not returned yet.
Held(r) == /\ pc[r] = "held"
           /\ funded' = [funded EXCEPT ![r] = TRUE]
           /\ Say(r, IF lost[r] THEN "funding_failed" ELSE "funded")
           /\ Go(r, "reserve")
           /\ UNCHANGED <<lock, db, chain>>

\* No money moved: the reservation commits under the lock or not at all (251).
Skip(r) == /\ pc[r] = "skip"
           /\ IF lost[r]
                THEN Leave(r, "error")
                ELSE Go(r, "reserve") /\ UNCHANGED outcome
           /\ UNCHANGED <<funded, lock, db, chain>>

Returned(r) == IF outcome[r] = "funded" THEN "ok" ELSE outcome[r]

\* owns(), reserve and recordTopUp in one tx (257-266). Not owning reserves nothing:
\* FloatLost when no money moved, LOST when it did. A tx that fails, before owns()
\* or after it, lands in the catch (268-275), which refuses funded when money
\* moved: nothing reserved its price.
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
                    /\ outcome' = [outcome EXCEPT ![r] = IF funded[r] THEN "funding_failed" ELSE "error"]
                    /\ UNCHANGED visible
              /\ Go(r, "finally")
              /\ UNCHANGED <<funded, lock, live, topUp, chain>>

\* After the turn the caller signs: markSigned makes the price count (store.ts:154).
Sign(r) == /\ pc[r] = "sign"
           /\ visible' = [visible EXCEPT ![r] = TRUE]
           /\ Go(r, "done")
           /\ UNCHANGED <<funded, outcome, lock, live, topUp, chain>>

(* Disconnect turn, disconnect.ts *)

\* A top-up in flight refuses first (191). Then returnFunds reads (282-341): a
\* batch to send, or nothing sent (348, 382).
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

\* sender.send (386): the batch revokes the grant and sweeps, or nothing lands.
Sweep(d) == /\ pc[d] = "sweep"
            /\ \/ /\ revokedOnChain' = TRUE
                  /\ Go(d, "end")
                  /\ UNCHANGED outcome
               \/ /\ Leave(d, "refused")
                  /\ UNCHANGED revokedOnChain
            /\ UNCHANGED <<funded, lock, db, moved, lateSend, staleTopUp>>

\* endConnection (194, rows.ts:198).
End(d) == /\ pc[d] = "end"
          /\ ~InFlight
          /\ live' = FALSE
          /\ Leave(d, "ok")
          /\ UNCHANGED <<funded, lock, topUp, visible, chain>>

\* It throws SendInFlight while a top-up may still land (rows.ts:206).
EndBusy(d) == /\ pc[d] = "end"
              /\ InFlight
              /\ Leave(d, "busy")
              /\ UNCHANGED <<funded, lock, db, chain>>

(* Execute turn, session-execute.ts *)

\* chainView, then the settle writes (231-237). The read sees which runs the chain
\* logged by its head, and fit's period read is pinned to that head: snap is what
\* moved by then. The writes settle the open ones, or fail and leave them open. A read
\* that fails or runs past its bound sees nothing and pins nothing.
Settle(e) == /\ pc[e] = "settle"
             /\ \/ /\ seen' = [seen EXCEPT ![e] = {x \in Execs : op[x] \in {"landed", "reverted"}}]
                   /\ snap' = [snap EXCEPT ![e] = ExecSpent]
                   /\ pinned' = [pinned EXCEPT ![e] = TRUE]
                   /\ \/ row' = [x \in Execs |-> IF row[x] = "open" /\ op[x] = "landed" THEN "landed"
                                                 ELSE IF row[x] = "open" /\ op[x] = "reverted" THEN "released"
                                                 ELSE row[x]]
                      \/ UNCHANGED row
                \/ UNCHANGED <<row, seen, snap, pinned>>
             /\ Go(e, "replay")
             /\ UNCHANGED <<funded, outcome, lock, db, chain, op, pend>>

\* owns() and the live check in one tx (238-241): FloatLost, or nothing sent on an ended connection.
Replay(e) == /\ pc[e] = "replay"
             /\ IF ~Owns(e) THEN Leave(e, "error")
                ELSE IF ~live THEN Leave(e, "refused")
                ELSE Go(e, "pending") /\ UNCHANGED outcome
             /\ UNCHANGED <<funded, lock, db, chain, exec>>

\* heldSpends in its own tx (247): open runs and landed ones the read did not see,
\* since a receipt can land a run after the read, at a block past its head.
Pending(e) == /\ pc[e] = "pending"
              /\ pend' = [pend EXCEPT ![e] = {x \in Execs : row[x] \in {"open", "landed"} /\ x \notin seen[e]}]
              /\ Go(e, "fit")
              /\ UNCHANGED <<funded, outcome, lock, db, chain, row, op, seen, snap, pinned>>

\* fit reads the period spend from the chain (249), at the pinned head when there is one.
Fit(e) == /\ pc[e] = "fit"
          /\ IF (IF pinned[e] THEN snap[e] ELSE ExecSpent) + Cardinality(pend[e]) + 1 > ExecCap
               THEN Leave(e, "refused")
               ELSE Go(e, "record") /\ UNCHANGED outcome
          /\ UNCHANGED <<funded, lock, db, chain, exec>>

\* owns(), the live check, then recordSend in one tx (263-278): not owning throws
\* FloatLost, and an ended connection records nothing. owns() holds the connection
\* row, so an end waits on this tx and then sees the rows in flight.
Record(e) == /\ pc[e] = "record"
             /\ IF Owns(e) /\ live
                  THEN /\ row' = [row EXCEPT ![e] = "open"]
                       /\ Go(e, "assertExec")
                       /\ UNCHANGED outcome
                  ELSE /\ Leave(e, IF Owns(e) THEN "refused" ELSE "error")
                       /\ UNCHANGED row
             /\ UNCHANGED <<funded, lock, db, chain, op, pend, seen, snap, pinned>>

\* assertHeld (282): FloatLost is unsent, and noteSubmitted releases the rows.
AssertExec(e) == /\ pc[e] = "assertExec"
                 /\ IF lost[e]
                      THEN /\ row' = [row EXCEPT ![e] = "released"]
                           /\ Leave(e, "error")
                      ELSE /\ Go(e, "submit")
                           /\ UNCHANGED <<row, outcome>>
                 /\ UNCHANGED <<funded, lock, db, chain, op, pend, seen, snap, pinned>>

\* wallet_sendCalls (284): the bundler takes it, or a failure before it did
\* releases the rows. A maybe-sent failure keeps them open, as a send does.
Submit(e) == /\ pc[e] = "submit"
             /\ \/ /\ op' = [op EXCEPT ![e] = "sent"]
                   /\ Leave(e, "ok")
                   /\ UNCHANGED row
                \/ /\ row' = [row EXCEPT ![e] = "released"]
                   /\ Leave(e, "error")
                   /\ UNCHANGED op
             /\ UNCHANGED <<funded, lock, db, chain, pend, seen, snap, pinned>>

\* The userOp lands later, or reverts: on a grant revoked on chain it moves nothing.
ExecLand(e) == /\ op[e] = "sent"
               /\ op' = [op EXCEPT ![e] = IF revokedOnChain THEN "reverted" ELSE "landed"]
               /\ UNCHANGED <<turn, lock, db, chain, row, pend, seen, snap, pinned>>

\* The receipt, settleLogged or the reconciler settle a row from what the chain logged.
ExecConclude(e) == /\ row[e] = "open"
                   /\ op[e] \in {"landed", "reverted"}
                   /\ row' = [row EXCEPT ![e] = IF op[e] = "landed" THEN "landed" ELSE "released"]
                   /\ UNCHANGED <<turn, lock, db, chain, op, pend, seen, snap, pinned>>

(* revokeByGrant, rows.ts:157-180 *)

\* tryLockFloat, sendInFlight and the end in one tx (168-174).
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
               \/ Sweep(d) \/ End(d) \/ EndBusy(d) \/ Finally(d)
ExecStep(e) == \/ (Acquire(e) \/ GiveUp(e) \/ WaitBroken(e) \/ Finally(e)) /\ UNCHANGED exec
               \/ Settle(e) \/ Replay(e) \/ Pending(e) \/ Fit(e) \/ Record(e) \/ AssertExec(e) \/ Submit(e)
Step(t) == IF t \in Execs THEN ExecStep(t)
           ELSE /\ UNCHANGED exec
                /\ IF t \in Refills THEN RefillStep(t)
                   ELSE IF t \in Discs THEN DiscStep(t)
                   ELSE TryLock(t) \/ Deadline(t)

Terminated == \A t \in Threads : pc[t] = "done"
Done == Terminated /\ UNCHANGED vars

Next == \/ \E t \in Threads : Step(t)
        \/ \E t \in Holders : (Drop(t) \/ Notify(t)) /\ UNCHANGED exec
        \/ \E e \in Execs : ExecLand(e) \/ ExecConclude(e)
        \/ Done

Spec == Init /\ [][Next]_vars /\ \A t \in Threads : WF_vars(Step(t))

(* Properties *)

TypeOK == /\ pc \in [Threads -> {"wait", "poll", "check", "assert212", "addTopUp", "assert115",
                                  "send", "held", "skip", "reserve", "read", "assert335",
                                  "sweep", "end", "finally", "sign", "done", "replay",
                                  "settle", "pending", "fit", "record", "assertExec", "submit"}]
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
          /\ staleTopUp \in BOOLEAN
          /\ row \in [Execs -> {"none", "open", "landed", "released"}]
          /\ op \in [Execs -> {"none", "sent", "landed", "reverted"}]
          /\ pend \in [Execs -> SUBSET Execs]
          /\ seen \in [Execs -> SUBSET Execs]
          /\ snap \in [Execs -> 0..Cardinality(Execs)]
          /\ pinned \in [Execs -> BOOLEAN]

\* (a) The prices of turns that return ok never pass the cap checkCaps enforces.
CapHolds == Cardinality({r \in Refills : outcome[r] = "ok"}) * Price <= Cap

\* (b) Money that landed has its topUpAmount on the row, or its turn reports failure.
MovedRecorded == \A r \in Refills : moved[r] /\ topUp[r] = 0 => outcome[r] \in Failed

\* (f) No turn writes its top-up, and so sends it, after another turn took the
\* lock from it: the next holder's caps read always sees the top-up row.
NoStaleTopUp == ~staleTopUp

\* (c) No top-up lands once the connection is no longer live.
NoSendAfterEnd == ~lateSend

\* (d) A turn that moved money returns a funded outcome to its caller.
MovedReachesCaller == \A r \in Refills :
                        moved[r] /\ pc[r] \in {"sign", "done"} => outcome[r] \in {"ok", "funding_failed"}

\* (e) Every turn waiting on the lock gets it or gives up.
Waiting(t) == pc[t] \in {"wait", "poll"}
WaitEnds == \A t \in Threads : Waiting(t) ~> ~Waiting(t)

\* (g) What executes moved on chain never passes the grant's limit, whatever the
\* lock and the receipts do.
ExecCapHolds == ExecSpent <= ExecCap

\* (h) A userOp the bundler took has its row recorded: open, or settled from the chain.
ExecRecorded == \A e \in Execs : op[e] # "none" => row[e] # "none"

\* (j) No execute submits once its connection ended.
NoExecAfterEnd == \A e \in Execs : pc[e] = "submit" => live

\* (i) fit never counts as open a run its settle read saw land, so that run counts
\* once, on chain.
CountedOnce == \A e \in Execs : pend[e] \cap seen[e] = {}

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
\* An execute about to submit while another turn holds the lock it lost.
ExecStolen == \E e \in Execs : pc[e] = "submit" /\ lockOwner \notin {None, e}
\* A run that landed and counts on chain while its row is still open.
ExecCountedTwice == \E e \in Execs : op[e] = "landed" /\ row[e] = "open"
====
