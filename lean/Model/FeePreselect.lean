/-
Which fee token the signing dialog opens on, after the coin's gas estimate succeeds.

Follows jaw-mono packages/ui:
- src/utils/feePreselect.ts `provenErc20` and `preselectFeeToken`;
- src/hooks/useGasEstimation.ts `pickFeeToken` (the setter the dialogs call) and
  `handleEthSuccess` (the step after a successful coin estimate).

Assumptions:
- A token is reduced to the facts the choice reads: whether it is the coin, its balance in
  its smallest unit, `isSelectable`, and whether its ceiling (`gasCostMaxFormatted`) is set.
- `need` is the coin fee in wei plus the value the calls send, as `handleEthSuccess` gets it.
  `parseEther` of the fee string is taken as exact, since the string comes from `formatUnits`.
- React state updates are applied in order; the owner-pick flag is a ref read synchronously.
- `gasFee` is set on every successful step and is not modelled. The error is a Boolean: true
  for `INSUFFICIENT_FUNDS_ERROR`, false for the empty string.
-/
namespace FeePreselect

structure Tok where
  isNative : Bool
  balance : Nat
  selectable : Bool
  priced : Bool
deriving DecidableEq, Repr

/-- feePreselect.ts `provenErc20`. -/
def provenErc20 (t : Tok) : Bool := !t.isNative && t.selectable && t.priced

/-- feePreselect.ts `preselectFeeToken`. -/
def preselectFeeToken (ts : List Tok) (need : Nat) : Option Tok :=
  match ts.find? (·.isNative) with
  | some c => if need ≤ c.balance then some c else ts.find? provenErc20
  | none => ts.find? provenErc20

/-- The coin is listed and its balance covers what it would be charged. -/
def coinCovers (ts : List Tok) (need : Nat) : Bool :=
  match ts.find? (·.isNative) with
  | some c => decide (need ≤ c.balance)
  | none => false

structure State where
  sel : Option Tok
  owner : Bool
  err : Bool
deriving DecidableEq, Repr

/-- useGasEstimation.ts `pickFeeToken`: a token is the owner's pick, null hands it back. -/
def pickFeeToken (s : State) (t : Option Tok) : State :=
  { s with sel := t, owner := t.isSome }

/-- useGasEstimation.ts `handleEthSuccess`. -/
def handleEthSuccess (s : State) (ts : List Tok) (need : Nat) : State :=
  if ts.isEmpty then { s with err := false }
  else
    let pick := preselectFeeToken ts need
    { sel := if s.owner then s.sel else pick
      owner := s.owner
      err := match pick with
        | some p => !p.isNative
        | none => true }

/-! Bounded search: every list of up to two tokens with balances up to 2, every need up to 2. -/

def toks : List Tok := Id.run do
  let mut out := []
  for n in [false, true] do
    for b in [0, 1, 2] do
      for s in [false, true] do
        for p in [false, true] do
          out := ⟨n, b, s, p⟩ :: out
  return out

def lists : List (List Tok) :=
  [[]] ++ toks.map ([·]) ++ toks.flatMap fun a => toks.map fun b => [a, b]

def cases : List (List Tok × Nat) := lists.flatMap fun ts => [0, 1, 2].map (ts, ·)

def solvent (ts : List Tok) (need : Nat) : Bool :=
  match preselectFeeToken ts need with
  | some p => (p.isNative && decide (need ≤ p.balance)) || (!p.isNative && p.selectable && p.priced)
  | none => true

def member (ts : List Tok) (need : Nat) : Bool :=
  match preselectFeeToken ts need with
  | some p => ts.contains p
  | none => true

def noneIffNothingPays (ts : List Tok) (need : Nat) : Bool :=
  (preselectFeeToken ts need).isNone == (!coinCovers ts need && !ts.any provenErc20)

def coinPreferred (ts : List Tok) (need : Nat) : Bool :=
  !coinCovers ts need || (preselectFeeToken ts need).any (·.isNative)

def errIffCoinShort (ts : List Tok) (need : Nat) : Bool :=
  ts.isEmpty || ((handleEthSuccess ⟨none, false, false⟩ ts need).err == !coinCovers ts need)

#guard cases.all fun (ts, n) => solvent ts n && member ts n && noneIffNothingPays ts n
#guard cases.all fun (ts, n) => coinPreferred ts n && errIffCoinShort ts n

-- The search reaches each outcome: the coin, an ERC-20, and nothing.
#guard cases.any fun (ts, n) => (preselectFeeToken ts n).any (·.isNative)
#guard cases.any fun (ts, n) => (preselectFeeToken ts n).any (!·.isNative)
#guard cases.any fun (ts, n) => !ts.isEmpty && (preselectFeeToken ts n).isNone

/-! Proofs for every list and every need. -/

theorem find_holds {p : Tok → Bool} {ts : List Tok} {t : Tok} (h : ts.find? p = some t) :
    p t = true := List.find?_some h

/-- A preselected token can pay: the coin covering its need, or an ERC-20 the paymaster proved. -/
theorem preselect_solvent (ts : List Tok) (need : Nat) (p : Tok)
    (h : preselectFeeToken ts need = some p) :
    (p.isNative = true ∧ need ≤ p.balance) ∨
      (p.isNative = false ∧ p.selectable = true ∧ p.priced = true) := by
  unfold preselectFeeToken at h
  split at h
  · rename_i c hc
    split at h
    · cases h; exact Or.inl ⟨find_holds hc, by omega⟩
    · have hp := find_holds h
      simp only [provenErc20, Bool.and_eq_true, Bool.not_eq_eq_eq_not, Bool.not_true] at hp
      exact Or.inr ⟨hp.1.1, hp.1.2, hp.2⟩
  · have hp := find_holds h
    simp only [provenErc20, Bool.and_eq_true, Bool.not_eq_eq_eq_not, Bool.not_true] at hp
    exact Or.inr ⟨hp.1.1, hp.1.2, hp.2⟩

/-- A preselected token is one of the options offered. -/
theorem preselect_member (ts : List Tok) (need : Nat) (p : Tok)
    (h : preselectFeeToken ts need = some p) : p ∈ ts := by
  unfold preselectFeeToken at h
  split at h
  · rename_i c hc
    split at h
    · cases h; exact List.mem_of_find?_eq_some hc
    · exact List.mem_of_find?_eq_some h
  · exact List.mem_of_find?_eq_some h

/-- When the coin covers its need, the dialog opens on the coin. -/
theorem preselect_prefers_coin (ts : List Tok) (need : Nat) (h : coinCovers ts need = true) :
    ∃ c, ts.find? (·.isNative) = some c ∧ preselectFeeToken ts need = some c := by
  simp only [coinCovers] at h
  cases hc : ts.find? (·.isNative) with
  | none => simp [hc] at h
  | some c =>
    simp only [hc, decide_eq_true_eq] at h
    exact ⟨c, rfl, by simp [preselectFeeToken, hc, h]⟩

/-- A proven ERC-20 is never the coin. -/
theorem proven_not_coin {t : Tok} (h : provenErc20 t = true) : t.isNative = false := by
  simp only [provenErc20, Bool.and_eq_true, Bool.not_eq_eq_eq_not, Bool.not_true] at h
  exact h.1.1

/-- Nothing is preselected exactly when neither the coin nor any proven ERC-20 can pay. -/
theorem preselect_none_iff (ts : List Tok) (need : Nat) :
    preselectFeeToken ts need = none ↔
      coinCovers ts need = false ∧ ∀ t ∈ ts, provenErc20 t = false := by
  simp only [preselectFeeToken, coinCovers]
  cases hc : ts.find? (·.isNative) with
  | none => simp [List.find?_eq_none]
  | some c =>
    by_cases hn : need ≤ c.balance
    · simp [hn]
    · simp [hn, List.find?_eq_none]

/-- The step reports the funds error exactly when the coin cannot cover its need. -/
theorem step_err_iff (s : State) (ts : List Tok) (need : Nat) (hne : ts ≠ []) :
    (handleEthSuccess s ts need).err = true ↔ coinCovers ts need = false := by
  have hempty : ts.isEmpty = false := by cases ts <;> simp_all
  simp only [handleEthSuccess, hempty, preselectFeeToken, coinCovers]
  cases hc : ts.find? (·.isNative) with
  | some c =>
    by_cases hn : need ≤ c.balance
    · simp [hn, find_holds hc]
    · cases hp : ts.find? provenErc20 with
      | none => simp [hn]
      | some p => simp [hn, proven_not_coin (find_holds hp)]
  | none =>
    cases hp : ts.find? provenErc20 with
    | none => simp
    | some p => simp [proven_not_coin (find_holds hp)]

/-- The owner's pick is never replaced by the preselection. -/
theorem step_keeps_owner_pick (s : State) (ts : List Tok) (need : Nat) (h : s.owner = true) :
    (handleEthSuccess s ts need).sel = s.sel := by
  unfold handleEthSuccess
  split <;> simp_all

/-- Without an owner pick, a non-empty list leaves the preselection selected. -/
theorem step_takes_preselect (s : State) (ts : List Tok) (need : Nat)
    (h : s.owner = false) (hne : ts ≠ []) :
    (handleEthSuccess s ts need).sel = preselectFeeToken ts need := by
  have hempty : ts.isEmpty = false := by cases ts <;> simp_all
  unfold handleEthSuccess
  simp [hempty, h]

/-- A reset to nothing hands the choice back to the preselection. -/
theorem reset_hands_back (s : State) : (pickFeeToken s none).owner = false := rfl

/-- Picking a token marks it as the owner's. -/
theorem pick_is_owner (s : State) (t : Tok) : (pickFeeToken s (some t)).owner = true := rfl

/-! Differential vectors, compared with the production function in feePreselect.test.ts. -/

def vectors : List (List Tok × Nat) :=
  [ ([⟨true, 2, true, false⟩, ⟨false, 5, true, true⟩], 2),
    ([⟨true, 1, true, false⟩, ⟨false, 5, true, true⟩], 2),
    ([⟨false, 5, true, true⟩], 2),
    ([⟨true, 1, true, false⟩, ⟨false, 5, false, false⟩, ⟨false, 5, true, true⟩], 2),
    ([⟨true, 1, true, false⟩, ⟨false, 5, true, false⟩], 2),
    ([⟨true, 0, false, false⟩], 0),
    ([], 1) ]

#eval vectors.map fun (ts, n) => (preselectFeeToken ts n)

end FeePreselect
