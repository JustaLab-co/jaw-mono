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

/-- relayOrder.ts `refundsOf`, the loop. -/
def refundRows (table : Table) : List Refund → Option (List (Nat × Nat))
  | [] => some []
  | r :: rs =>
    match table r.chain with
    | none => none
    | some c => if isAddress r.recipient then (refundRows table rs).map ((c, r.recipient.val) :: ·) else none

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
  (∀ row ∈ v.refunds, ∃ r ∈ o.refunds, table r.chain = some row.1 ∧ isAddress r.recipient = true ∧ r.recipient.val = row.2) ∧
  (∀ r ∈ o.refunds, ∃ row ∈ v.refunds, table r.chain = some row.1 ∧ row.2 = r.recipient.val)

instance (table : Table) (o : Order) (v : View) : Decidable (commits table o v) := by
  unfold commits; infer_instance

/-- transfer.ts `relayTransfer`: every address the screen prints. -/
def shown (v : View) : List Nat := v.recipient :: v.refunds.map Prod.snd

/-- transfer.ts `relayTransfer`: the addresses named in a yellow notice. -/
def warned (account : Nat) (v : View) : List Nat :=
  (if v.recipient ≠ account then [v.recipient] else []) ++
  (v.refunds.map Prod.snd).filter fun a => decide (a ≠ account ∧ a ≠ v.recipient)

/-! Bounded search over small orders, with Base and Arbitrum in the table. -/

def table : Table := fun c => if c = 0 then some 8453 else if c = 1 then some 42161 else none

def bytes : List Bytes := [20, 32].flatMap fun len => [1, 2, 3].map fun val => ⟨len, val⟩

def upTo2 {α} (xs : List α) : List (List α) := [[]] ++ xs.map ([·]) ++ xs.flatMap fun a => xs.map fun b => [a, b]

def orders : List Order :=
  let refunds := upTo2 ([0, 1, 2].flatMap fun c => bytes.map fun b => ⟨c, b⟩)
  let payments := upTo2 (bytes.map fun b => ⟨b, 7⟩)
  [1, 2].flatMap fun version => [0, 1, 2].flatMap fun outChain => [0, 1].flatMap fun calls =>
    payments.flatMap fun ps => refunds.map fun rs => ⟨version, outChain, ps, calls, 0, rs⟩

def badOrders : List Order :=
  orders.filter fun o => match termsOf table o with
    | some v => !decide (commits table o v) || [1, 2, 3].any fun account =>
        (shown v).any fun a => a != account && !(warned account v).contains a
    | none => false

#guard badOrders.isEmpty

/-- The 11c order: 2 USDC from Base, paid to 0x93ad… on Arbitrum, refunded on Base to the
depositor 0xfabc… and on Arbitrum to the recipient. -/
def order11c : Order :=
  ⟨1, 1, [⟨⟨20, 0x93ad⟩, 1910824⟩], 0, 0, [⟨0, ⟨20, 0xfabc⟩⟩, ⟨1, ⟨20, 0x93ad⟩⟩]⟩

#guard termsOf table order11c = some ⟨42161, 0x93ad, 1910824, [(8453, 0xfabc), (42161, 0x93ad)]⟩
#guard warned 0xfabc ⟨42161, 0x93ad, 1910824, [(8453, 0xfabc), (42161, 0x93ad)]⟩ = [0x93ad]
#guard (orders.filter fun o => (termsOf table o).isSome).length > 0

/-! Proofs for every order, table and hash. -/

theorem refundRows_sound (table : Table) :
    ∀ (rs : List Refund) (rows : List (Nat × Nat)), refundRows table rs = some rows →
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
        cases hrest : refundRows table rs with
        | none => simp [hrest] at h
        | some tail =>
          simp [hrest] at h
          subst h
          obtain ⟨ih1, ih2⟩ := ih tail hrest
          constructor
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
          obtain ⟨s1, s2⟩ := refundRows_sound table o.refunds _ hrows
          refine ⟨by simp [hp], ?_, hd, by simp, s1, s2⟩
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
    simp only [warned, List.mem_append, List.mem_filter, decide_eq_true_eq]
    rcases ha with rfl | ha
    · left; simp [hacc]
    · by_cases hr : a = v.recipient
      · subst hr; left; simp [hacc]
      · right; exact ⟨ha, hacc, hr⟩

end RelayOrderView
