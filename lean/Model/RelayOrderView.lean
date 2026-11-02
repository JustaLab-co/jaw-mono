/-
When the signing screen shows a Relay order's terms, and which addresses it prints.

Follows jaw-mono packages/ui/src/utils/bridgeCalls:
- relayOrder.ts `readRelayOrder` (the hash gate), `termsOf` and `refundsOf`;
- transfer.ts `relayTransfer` (the recipient and refund rows, and the yellow notices).

Assumptions:
- A byte string is its length in bytes and its value. Addresses are compared lowercased,
  so equal values mean equal addresses.
- Protocol chain names are numbers, and the bridge table maps a name to a chain id.
- The checks `readRelayOrder` runs between the hash and `termsOf` (input chain, token,
  amount, `knownRoute`) and the token checks in `termsOf` only reject orders. They are
  left out, since rejecting more orders cannot make a shown order commit to less.
- `hashStruct` is injective on orders. It is a hypothesis of `shown_terms_commit`,
  standing for the collision resistance of the EIP-712 hash.
- `knownRoute` is not modelled: it only rejects orders, so a shown order here is a superset
  of what production shows.
- The refund currency, minimum and deadline are parsed but not shown, so they are not
  modelled. The screen claims nothing about the refund token.
- Notices are deduplicated in production; membership is all the properties use.
-/
namespace RelayOrderView

structure Bytes where
  len : Nat
  val : Nat
deriving DecidableEq, Repr

structure Refund where
  chain : Nat
  recipient : Bytes
deriving DecidableEq, Repr

structure Payment where
  recipient : Bytes
  minimum : Nat
deriving DecidableEq, Repr

structure Order where
  version : Nat
  outChain : Nat
  payments : List Payment
  calls : Nat
  fees : Nat
  refunds : List Refund
deriving DecidableEq, Repr

/-- What the screen shows: destination chain id, recipient, minimum out, and one
(chain id, address) row per refund. -/
structure View where
  dest : Nat
  recipient : Nat
  minimum : Nat
  refunds : List (Nat × Nat)
deriving DecidableEq, Repr

abbrev Table := Nat → Option Nat

def isAddress (b : Bytes) : Bool := b.len == 20

/-- relayOrder.ts `refundsOf`, the loop: a refund on a chain already seen refuses the order. -/
def refundRows (table : Table) : List Refund → Option (List (Nat × Nat))
  | [] => some []
  | r :: rs =>
    match table r.chain with
    | none => none
    | some c =>
      if isAddress r.recipient then
        match refundRows table rs with
        | some rows => if rows.any (·.1 == c) then none else some ((c, r.recipient.val) :: rows)
        | none => none
      else none

/-- relayOrder.ts `refundsOf`: no refunds at all is not shown. -/
def refundsOf (table : Table) (rs : List Refund) : Option (List (Nat × Nat)) :=
  match refundRows table rs with
  | some (x :: xs) => some (x :: xs)
  | _ => none

/-- relayOrder.ts `termsOf`. -/
def termsOf (table : Table) (o : Order) : Option View :=
  if o.version ≠ 1 then none
  else if o.calls ≠ 0 then none
  else if o.fees ≠ 0 then none
  else match o.payments with
    | [p] =>
      match table o.outChain with
      | none => none
      | some d =>
        if isAddress p.recipient then (refundsOf table o.refunds).map fun rs => ⟨d, p.recipient.val, p.minimum, rs⟩
        else none
    | _ => none

/-- relayOrder.ts `readRelayOrder`: terms show only for the order that hashes to the deposit's id. -/
def readRelayOrder (hash : Order → Nat) (orderId : Nat) (table : Table) (o : Order) : Option View :=
  if hash o = orderId then termsOf table o else none

/-- Every value on the screen comes from the order, and every refund in the order is on it. -/
def commits (table : Table) (o : Order) (v : View) : Prop :=
  o.payments.length = 1 ∧
  (∀ p ∈ o.payments, isAddress p.recipient = true ∧ v.recipient = p.recipient.val ∧ v.minimum = p.minimum) ∧
  table o.outChain = some v.dest ∧
  v.refunds ≠ [] ∧
  (v.refunds.map Prod.fst).Nodup ∧
  (∀ row ∈ v.refunds, ∃ r ∈ o.refunds, table r.chain = some row.1 ∧ isAddress r.recipient = true ∧ r.recipient.val = row.2) ∧
  (∀ r ∈ o.refunds, ∃ row ∈ v.refunds, table r.chain = some row.1 ∧ row.2 = r.recipient.val)

instance (table : Table) (o : Order) (v : View) : Decidable (commits table o v) := by
  unfold commits; infer_instance

/-- transfer.ts `relayTransfer`: every address the screen prints. -/
def shown (v : View) : List Nat := v.recipient :: v.refunds.map Prod.snd

/-- transfer.ts `relayTransfer`: refund addresses named in a yellow notice. A refund to the
recipient is exempt only on the destination chain, the one place the recipient is known to
hold that address. -/
def refundWarned (account : Nat) (v : View) : List Nat :=
  (v.refunds.filter fun row => decide (row.2 ≠ account ∧ ¬(row.1 = v.dest ∧ row.2 = v.recipient))).map Prod.snd

/-- transfer.ts `relayTransfer`: every address named in a yellow notice. -/
def warned (account : Nat) (v : View) : List Nat :=
  (if v.recipient ≠ account then [v.recipient] else []) ++ refundWarned account v

/-! Bounded search over small orders, with Base and Arbitrum in the table. -/

def table : Table := fun c => if c = 0 then some 8453 else if c = 1 then some 42161 else if c = 2 then some 10 else none

def bytes : List Bytes := [⟨20, 1⟩, ⟨20, 2⟩, ⟨32, 1⟩]

def upTo2 {α} (xs : List α) : List (List α) := [[]] ++ xs.map ([·]) ++ xs.flatMap fun a => xs.map fun b => [a, b]

def upTo3 {α} (xs : List α) : List (List α) := [[]] ++ (upTo2 xs).filter (· ≠ []) ++
  xs.flatMap fun a => xs.flatMap fun b => xs.map fun c => [a, b, c]

def orders : List Order :=
  let refunds := upTo3 ([0, 1, 2].flatMap fun c => bytes.map fun b => ⟨c, b⟩)
  let payments := upTo2 (bytes.map fun b => ⟨b, 7⟩)
  [1, 2].flatMap fun version => [0, 1, 3].flatMap fun outChain => [0, 1].flatMap fun calls =>
    payments.flatMap fun ps => refunds.map fun rs => ⟨version, outChain, ps, calls, 0, rs⟩

def badOrders : List Order :=
  orders.filter fun o => match termsOf table o with
    | some v => !decide (commits table o v) || [1, 2, 3].any fun account =>
        (shown v).any (fun a => a != account && !(warned account v).contains a) ||
        v.refunds.any fun row => row.2 != account && row.1 != v.dest && !(refundWarned account v).contains row.2
    | none => false

#guard badOrders.isEmpty

/-- The 11c order: 2 USDC from Base, paid to 0x93ad… on Arbitrum, refunded on Base to the
depositor 0xfabc… and on Arbitrum to the recipient. -/
def order11c : Order :=
  ⟨1, 1, [⟨⟨20, 0x93ad⟩, 1910824⟩], 0, 0, [⟨0, ⟨20, 0xfabc⟩⟩, ⟨1, ⟨20, 0x93ad⟩⟩]⟩

#guard termsOf table order11c = some ⟨42161, 0x93ad, 1910824, [(8453, 0xfabc), (42161, 0x93ad)]⟩
#guard warned 0xfabc ⟨42161, 0x93ad, 1910824, [(8453, 0xfabc), (42161, 0x93ad)]⟩ = [0x93ad]
#guard (orders.filter fun o => (termsOf table o).isSome).length > 0
#guard (orders.filter fun o => o.refunds.length = 3 ∧ (termsOf table o).isSome).length > 0
#guard termsOf table { order11c with refunds := [⟨0, ⟨20, 0xfabc⟩⟩, ⟨0, ⟨20, 0x93ad⟩⟩] } = none
#guard refundWarned 0xfabc ⟨42161, 0x93ad, 1, [(8453, 0x93ad), (42161, 0x93ad)]⟩ = [0x93ad]

/-! Proofs for every order, table and hash. -/

theorem refundRows_sound (table : Table) :
    ∀ (rs : List Refund) (rows : List (Nat × Nat)), refundRows table rs = some rows →
      (rows.map Prod.fst).Nodup ∧
      (∀ row ∈ rows, ∃ r ∈ rs, table r.chain = some row.1 ∧ isAddress r.recipient = true ∧ r.recipient.val = row.2) ∧
      (∀ r ∈ rs, ∃ row ∈ rows, table r.chain = some row.1 ∧ row.2 = r.recipient.val) := by
  intro rs
  induction rs with
  | nil =>
    intro rows h
    simp [refundRows] at h
    subst h
    simp
  | cons r rs ih =>
    intro rows h
    simp only [refundRows] at h
    split at h
    · contradiction
    · rename_i c hc
      split at h
      · rename_i ha
        split at h
        · rename_i tail hrest
          split at h
          · contradiction
          · rename_i hnew
            simp only [Option.some.injEq] at h
            subst h
            obtain ⟨ih0, ih1, ih2⟩ := ih tail hrest
            refine ⟨?_, ?_, ?_⟩
            · simp only [List.map_cons, List.nodup_cons]
              refine ⟨?_, ih0⟩
              intro hmem
              simp only [List.mem_map] at hmem
              obtain ⟨row, hrow, hrc⟩ := hmem
              apply hnew
              simp only [List.any_eq_true, beq_iff_eq]
              exact ⟨row, hrow, hrc⟩
            · intro row hrow
              simp only [List.mem_cons] at hrow
              rcases hrow with rfl | hrow
              · exact ⟨r, by simp, hc, ha, rfl⟩
              · obtain ⟨r', hr', h'⟩ := ih1 row hrow
                exact ⟨r', by simp [hr'], h'⟩
            · intro r' hr'
              simp only [List.mem_cons] at hr'
              rcases hr' with rfl | hr'
              · exact ⟨(c, r'.recipient.val), by simp, hc, rfl⟩
              · obtain ⟨row, hrow, h'⟩ := ih2 r' hr'
                exact ⟨row, by simp [hrow], h'⟩
        · contradiction
      · contradiction

theorem termsOf_commits (table : Table) (o : Order) (v : View) (h : termsOf table o = some v) :
    commits table o v := by
  unfold termsOf at h
  split at h
  · contradiction
  split at h
  · contradiction
  split at h
  · contradiction
  split at h
  · rename_i p hp
    split at h
    · contradiction
    · rename_i d hd
      split at h
      · rename_i ha
        unfold refundsOf at h
        split at h
        · rename_i x xs hrows
          simp at h
          subst h
          obtain ⟨s0, s1, s2⟩ := refundRows_sound table o.refunds _ hrows
          refine ⟨by simp [hp], ?_, hd, by simp, s0, s1, s2⟩
          intro q hq
          simp [hp] at hq
          subst hq
          exact ⟨ha, rfl, rfl⟩
        · simp at h
      · contradiction
  · contradiction

/-- A view the screen shows commits to the order the deposit commits to. -/
theorem shown_terms_commit (hash : Order → Nat) (hinj : Function.Injective hash) (committed o : Order)
    (orderId : Nat) (hid : hash committed = orderId) (table : Table) (v : View)
    (h : readRelayOrder hash orderId table o = some v) : commits table committed v := by
  unfold readRelayOrder at h
  split at h
  · rename_i ho
    have : o = committed := hinj (ho.trans hid.symm)
    subst this
    exact termsOf_commits table o v h
  · contradiction

/-- Every address the screen prints is this account or named in a yellow notice. -/
theorem shown_is_account_or_warned (account : Nat) (v : View) :
    ∀ a ∈ shown v, a = account ∨ a ∈ warned account v := by
  intro a ha
  by_cases hacc : a = account
  · exact Or.inl hacc
  · right
    simp only [shown, List.mem_cons] at ha
    simp only [warned, refundWarned, List.mem_append]
    rcases ha with rfl | ha
    · left; simp [hacc]
    · by_cases hr : a = v.recipient
      · subst hr; left; simp [hacc]
      · right
        simp only [List.mem_map] at ha ⊢
        obtain ⟨row, hrow, rfl⟩ := ha
        refine ⟨row, ?_, rfl⟩
        simp only [List.mem_filter, decide_eq_true_eq]
        exact ⟨hrow, hacc, fun h => hr h.2⟩

/-- A refund to an address other than this account, on a chain other than the destination,
is always named in a refund notice, even when it is the recipient's address. -/
theorem offchain_refund_warned (account : Nat) (v : View) :
    ∀ row ∈ v.refunds, row.2 ≠ account → row.1 ≠ v.dest → row.2 ∈ refundWarned account v := by
  intro row hrow hacc hdest
  simp only [refundWarned, List.mem_map, List.mem_filter, decide_eq_true_eq]
  exact ⟨row, ⟨hrow, hacc, fun h => hdest h.1⟩, rfl⟩

end RelayOrderView
