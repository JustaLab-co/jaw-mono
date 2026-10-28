---- MODULE FloatSlots ----
(* In-process admission in front of the float lock, on one Node replica.

   Follows:
     apps/mcp/src/payments/float-lock.ts
       43-70   withFloat: per-connection `sessions` counter (cap 2), slots.take,
               slots.give in the inner finally, counter decrement in the outer
       52-53   the PGlite branch, which queues on inTurn(`pglite:<id>`) instead
       159-188 slots: free counter, waiting list, take(deadline) with a timer
               that splices the waiter out and rejects FloatBusy, give()
       190-201 inTurn: per-key promise chain, tail cleanup if still the latest
     apps/mcp/src/payments/refill.ts
       145-161 queuedWithin: timer resolves timed_out only if not started
       171-178 refillHook: queuedWithin(inTurn(withFloat(...)))

   Assumptions:
   - One event loop. Each synchronous run between awaits is one step; timer
     callbacks and promise reactions are separate steps. Start of a refill
     work and its entry into withFloat are split into two steps (in the code
     they are one synchronous run); that only adds interleavings.
   - Time is a per-caller flag `expired`: the budget minus SEND_RESERVE_MS
     reached zero. The queuedWithin timer and the slot timer of a refill
     caller both fire at that instant (waitMs = budget.left() - reserve), so
     both are guarded by it. A direct withFloat caller (send, end, disconnect)
     uses the same flag for its LOCK_WAIT_MS deadline.
   - The budget is `until(...)` (pay.ts:292), so it only shrinks: a work that
     starts after its timer fired sees waitMs <= 0 < MIN_REFILL_MS and returns
     timed_out at refill.ts:175. Start may also take that branch before expiry
     (the 5 s window above zero).
   - hold() (lines 72-120) is one abstract step: it ends, whatever it does.
   - Expiry has no fairness, so the liveness properties hold even when no
     timer ever fires. All caller steps are weakly fair.
   - Refill callers and direct callers; a refill caller reaches withFloat
     only through inTurn on its connection id. *)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS Refill, Direct, OnA, Slots, Pglite

Cap == 2
None == "none"
Callers == Refill \cup Direct
Conns == {"a", "b"}
Kinds == {"turn", "pglite"}
Keys == Conns \X Kinds
ConnOf(c) == IF c \in OnA THEN "a" ELSE "b"
KeyOf(c, kind) == <<ConnOf(c), kind>>
After(c) == IF c \in Refill THEN "wdone" ELSE "done"

PCs == {"idle", "queued", "wf_enter", "waitslot", "granted", "holding",
        "rejected", "pg_queued", "pg_holding", "wdone", "done"}
InSession == {"waitslot", "granted", "holding", "rejected"}
InFloat == {"wf_enter", "pg_queued", "pg_holding"} \cup InSession

VARIABLES pc, expired, started, qtimer, answer,   \* per caller
          stimer, tookRejected,                    \* slot timers
          free, waiting,                           \* slots
          sessions, sessKeys,                      \* sessions map
          pred, latest, settled, tailDue           \* inTurn queues map

caller == <<pc, expired, started, qtimer, answer>>
timers == <<stimer, tookRejected>>
slots == <<free, waiting>>
sess == <<sessions, sessKeys>>
turns == <<pred, latest, settled, tailDue>>
vars == <<caller, timers, slots, sess, turns>>

Init == /\ pc = [c \in Callers |-> IF c \in Refill THEN "idle" ELSE "wf_enter"]
        /\ expired = [c \in Callers |-> FALSE]
        /\ started = [c \in Callers |-> FALSE]
        /\ qtimer = [c \in Callers |-> FALSE]
        /\ answer = [c \in Callers |-> "pending"]
        /\ stimer = [c \in Callers |-> FALSE]
        /\ tookRejected = {}
        /\ free = Slots
        /\ waiting = <<>>
        /\ sessions = [k \in Conns |-> 0]
        /\ sessKeys = {}
        /\ pred = [x \in Callers \X Kinds |-> None]
        /\ latest = [k \in Keys |-> None]
        /\ settled = {}
        /\ tailDue = {}

Goto(c, s) == pc' = [pc EXCEPT ![c] = s]

\* inTurn 193,198: chain on the current entry, then become the entry.
Enqueue(c, kind) ==
  /\ pred' = [pred EXCEPT ![<<c, kind>>] = latest[KeyOf(c, kind)]]
  /\ latest' = [latest EXCEPT ![KeyOf(c, kind)] = c]
  /\ UNCHANGED <<settled, tailDue>>
\* `.then(work, work)` on the predecessor's tail.
Ready(c, kind) == pred[<<c, kind>>] = None \/ <<pred[<<c, kind>>], kind>> \in settled
\* `run` settles; its tail cleanup (line 199) is now due.
Settle(c, kind) ==
  /\ settled' = settled \cup {<<c, kind>>}
  /\ tailDue' = tailDue \cup {<<c, kind>>}
  /\ UNCHANGED <<pred, latest>>

\* withFloat 66-68.
Leave(c) ==
  LET k == ConnOf(c) IN
  /\ sessions' = [sessions EXCEPT ![k] = @ - 1]
  /\ sessKeys' = IF sessions[k] - 1 > 0 THEN sessKeys ELSE sessKeys \ {k}

\* refill.ts 145-159: arm the timer, queue the work.
Call(c) == /\ pc[c] = "idle"
           /\ Goto(c, "queued")
           /\ qtimer' = [qtimer EXCEPT ![c] = TRUE]
           /\ Enqueue(c, "turn")
           /\ UNCHANGED <<expired, started, answer, timers, slots, sess>>

\* refill.ts 157 then 174-175: a late turn returns timed_out without withFloat.
Start(c) == /\ pc[c] = "queued"
            /\ Ready(c, "turn")
            /\ started' = [started EXCEPT ![c] = TRUE]
            /\ \/ Goto(c, "wdone")
               \/ ~expired[c] /\ Goto(c, "wf_enter")
            /\ UNCHANGED <<expired, qtimer, answer, timers, slots, sess, turns>>

\* refill.ts 149-151.
QTimer(c) == /\ qtimer[c] /\ expired[c]
             /\ qtimer' = [qtimer EXCEPT ![c] = FALSE]
             /\ answer' = IF ~started[c] /\ answer[c] = "pending"
                          THEN [answer EXCEPT ![c] = "timed_out"] ELSE answer
             /\ UNCHANGED <<pc, expired, started, timers, slots, sess, turns>>

\* withFloat 48-59 up to the await; take 162-181.
Enter(c) ==
  LET k == ConnOf(c) IN
  /\ pc[c] = "wf_enter"
  /\ IF Pglite
     THEN /\ Goto(c, "pg_queued")
          /\ Enqueue(c, "pglite")
          /\ UNCHANGED <<timers, slots, sess>>
     ELSE IF sessions[k] >= Cap
     THEN /\ Goto(c, After(c))
          /\ UNCHANGED <<timers, slots, sess, turns>>
     ELSE /\ sessions' = [sessions EXCEPT ![k] = @ + 1]
          /\ sessKeys' = sessKeys \cup {k}
          /\ IF free > 0
             THEN /\ free' = free - 1
                  /\ Goto(c, "granted")
                  /\ UNCHANGED <<waiting, timers>>
             ELSE /\ waiting' = Append(waiting, c)
                  /\ stimer' = [stimer EXCEPT ![c] = TRUE]
                  /\ Goto(c, "waitslot")
                  /\ UNCHANGED <<free, tookRejected>>
          /\ UNCHANGED turns
  /\ UNCHANGED <<expired, started, qtimer, answer>>

\* take 172-177: splice the waiter out and reject FloatBusy.
SlotTimer(c) == /\ pc[c] = "waitslot" /\ stimer[c] /\ expired[c]
                /\ waiting' = SelectSeq(waiting, LAMBDA x : x # c)
                /\ stimer' = [stimer EXCEPT ![c] = FALSE]
                /\ tookRejected' = tookRejected \cup {c}
                /\ Goto(c, "rejected")
                /\ UNCHANGED <<expired, started, qtimer, answer, free, sess, turns>>

\* The rejected await resumes: outer finally 65-68.
Reject(c) == /\ pc[c] = "rejected"
             /\ Leave(c)
             /\ Goto(c, After(c))
             /\ UNCHANGED <<expired, started, qtimer, answer, timers, slots, turns>>

\* The resolved take resumes into hold() (line 61).
Resume(c) == /\ pc[c] = "granted"
             /\ Goto(c, "holding")
             /\ UNCHANGED <<expired, started, qtimer, answer, timers, slots, sess, turns>>

\* hold() settles; inner finally give() 183-187, outer finally 65-68.
Release(c) ==
  /\ pc[c] = "holding"
  /\ IF waiting = <<>>
     THEN /\ free' = free + 1
          /\ Goto(c, After(c))
          /\ UNCHANGED <<waiting, stimer>>
     ELSE LET h == Head(waiting) IN
          /\ waiting' = Tail(waiting)
          /\ stimer' = [stimer EXCEPT ![h] = FALSE]
          /\ pc' = [pc EXCEPT ![c] = After(c), ![h] = "granted"]
          /\ UNCHANGED free
  /\ Leave(c)
  /\ UNCHANGED <<expired, started, qtimer, answer, tookRejected, turns>>

\* PGlite: the work runs on its turn of the `pglite:<id>` queue (line 53).
PgRun(c) == /\ pc[c] = "pg_queued"
            /\ Ready(c, "pglite")
            /\ Goto(c, "pg_holding")
            /\ UNCHANGED <<expired, started, qtimer, answer, timers, slots, sess, turns>>

PgRelease(c) == /\ pc[c] = "pg_holding"
                /\ Goto(c, After(c))
                /\ Settle(c, "pglite")
                /\ UNCHANGED <<expired, started, qtimer, answer, timers, slots, sess>>

\* The refill work settles: its inTurn run settles, the race settles, and the
\* finally clears the queuedWithin timer (refill.ts 160).
WorkDone(c) == /\ pc[c] = "wdone"
               /\ Goto(c, "done")
               /\ answer' = IF answer[c] = "pending"
                            THEN [answer EXCEPT ![c] = "result"] ELSE answer
               /\ qtimer' = [qtimer EXCEPT ![c] = FALSE]
               /\ Settle(c, "turn")
               /\ UNCHANGED <<expired, started, timers, slots, sess>>

\* inTurn 199: delete the entry only if it is still this tail.
Cleanup(x) == /\ x \in tailDue
              /\ tailDue' = tailDue \ {x}
              /\ latest' = IF latest[KeyOf(x[1], x[2])] = x[1]
                           THEN [latest EXCEPT ![KeyOf(x[1], x[2])] = None]
                           ELSE latest
              /\ UNCHANGED <<caller, timers, slots, sess, pred, settled>>

Expire(c) == /\ ~expired[c] /\ pc[c] # "done"
             /\ expired' = [expired EXCEPT ![c] = TRUE]
             /\ UNCHANGED <<pc, started, qtimer, answer, timers, slots, sess, turns>>

Step(c) == Call(c) \/ Start(c) \/ QTimer(c) \/ Enter(c) \/ SlotTimer(c)
           \/ Reject(c) \/ Resume(c) \/ Release(c) \/ PgRun(c)
           \/ PgRelease(c) \/ WorkDone(c)

\* Stutter at the end so that termination is not reported as a deadlock.
Finished == (\A c \in Callers : pc[c] = "done") /\ tailDue = {}
Terminated == Finished /\ UNCHANGED vars

Next == \/ \E c \in Callers : Step(c) \/ Expire(c)
        \/ \E x \in tailDue : Cleanup(x)
        \/ Terminated

Spec == /\ Init /\ [][Next]_vars
        /\ \A c \in Callers : WF_vars(Step(c))
        /\ \A x \in Callers \X Kinds : WF_vars(Cleanup(x))

----
Holders == {c \in Callers : pc[c] \in {"granted", "holding"}}
Elems(s) == {s[i] : i \in 1..Len(s)}

TypeOK == /\ pc \in [Callers -> PCs]
          /\ expired \in [Callers -> BOOLEAN]
          /\ started \in [Callers -> BOOLEAN]
          /\ qtimer \in [Callers -> BOOLEAN]
          /\ answer \in [Callers -> {"pending", "timed_out", "result"}]
          /\ stimer \in [Callers -> BOOLEAN]
          /\ tookRejected \subseteq Callers
          /\ free \in Nat
          /\ Elems(waiting) \subseteq Callers
          /\ sessions \in [Conns -> Nat]
          /\ sessKeys \subseteq Conns
          /\ latest \in [Keys -> Callers \cup {None}]
          /\ settled \subseteq Callers \X Kinds
          /\ tailDue \subseteq settled

\* (a) free + slots held or handed to a resolved take == MAX_HOLDS, never
\* negative; each waiter is parked once, and only while it waits.
SlotConservation ==
  /\ free \in 0..Slots
  /\ free + Cardinality(Holders) = Slots
  /\ Len(waiting) = Cardinality(Elems(waiting))
  /\ Elems(waiting) = {c \in Callers : pc[c] = "waitslot"}

\* (a) no waiter is parked while a slot is free.
NoStrandedWaiter == waiting # <<>> => free = 0

\* (b) a take whose timer rejected it never gets a slot via turn().
NoGrantAfterTimeout == \A c \in tookRejected : pc[c] \notin {"granted", "holding"}

\* (c) sessions.get(id) counts the callers between line 57 and line 66, never
\* exceeds 2, and the entry exists exactly while it is positive.
SessionsCount ==
  \A k \in Conns :
    /\ sessions[k] = Cardinality({c \in Callers : ConnOf(c) = k /\ pc[c] \in InSession})
    /\ sessions[k] <= Cap
    /\ (k \in sessKeys <=> sessions[k] > 0)

\* (d) at most one work per inTurn key runs at a time.
Running(key) ==
  {c \in Callers : /\ ConnOf(c) = key[1]
                   /\ IF key[2] = "turn"
                      THEN c \in Refill /\ started[c] /\ pc[c] # "done"
                      ELSE pc[c] = "pg_holding"}
TurnExclusive == \A key \in Keys : Cardinality(Running(key)) <= 1

\* (d) a refill whose caller got timed_out never enters withFloat.
NoOrphanFloat == \A c \in Refill : answer[c] = "timed_out" => pc[c] \notin InFloat

\* (e) every parked take resolves or rejects.
TakeSettles == \A c \in Callers : pc[c] = "waitslot" ~> pc[c] # "waitslot"
\* (e) every refill caller gets an answer, every caller finishes.
AllAnswered == <>(Finished /\ \A c \in Refill : answer[c] # "pending")
\* (e) the queues map and the sessions map end empty.
QueuesCleared == <>[](\A key \in Keys : latest[key] = None)
SessionsCleared == <>[](sessKeys = {})

\* Reach predicates.
WaiterParked == waiting # <<>>
TakeTimedOut == tookRejected # {}
CapFull == \E k \in Conns : sessions[k] = Cap
TimedOutStillQueued == \E c \in Refill : answer[c] = "timed_out" /\ pc[c] = "queued"
TimedOutThenStarted == \E c \in Refill : answer[c] = "timed_out" /\ started[c]
Chained == \E c \in Refill : pc[c] = "queued" /\ pred[<<c, "turn">>] # None
EntryKeptForLater == \E x \in tailDue : latest[KeyOf(x[1], x[2])] # x[1] /\ latest[KeyOf(x[1], x[2])] # None
PgChained == \E c \in Callers : pc[c] = "pg_queued" /\ pred[<<c, "pglite">>] # None
====
