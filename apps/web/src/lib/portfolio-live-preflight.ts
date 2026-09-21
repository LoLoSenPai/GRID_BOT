/** Read-only preparation, never a reservation or permission to execute. Amounts are USDC/SOL. */
export function evaluateLivePreflight(input: {
  totalCapital: number; baseAllocation: number; feeSol: number;
  walletUsdc: number; walletSol: number; quoteClaims: number; solClaims: number;
  observedAt: number; now: number; blockers: string[];
}) {
  const blockers = [...input.blockers];
  const amounts = [input.totalCapital, input.baseAllocation, input.feeSol, input.walletUsdc,
    input.walletSol, input.quoteClaims, input.solClaims];
  const valid = amounts.every(n => Number.isFinite(n) && n >= 0);
  if (!valid) blockers.push("Invalid or unavailable capital observation.");
  if (!(input.baseAllocation >= 100) || !(input.totalCapital >= 2 * input.baseAllocation))
    blockers.push("Fund equal BTC/SOL base allocations of at least 100 USDC.");
  if (!(input.feeSol > 0)) blockers.push("An explicit positive SOL fee envelope is required.");
  if (!Number.isFinite(input.now) || !Number.isFinite(input.observedAt) ||
    input.now - input.observedAt > 30_000 || input.observedAt > input.now)
    blockers.push("Wallet observation is stale or invalid.");
  const freeUsdc = valid ? Math.max(0, input.walletUsdc - input.quoteClaims) : null;
  const freeSol = valid ? Math.max(0, input.walletSol - input.solClaims) : null;
  if (valid && input.quoteClaims > input.walletUsdc) blockers.push("Existing USDC claims exceed the wallet balance.");
  if (valid && input.solClaims > input.walletSol) blockers.push("Existing SOL inventory exceeds the native SOL balance; reconcile native/wrapped holdings.");
  if (freeUsdc !== null && input.totalCapital > freeUsdc) blockers.push("Insufficient unallocated USDC.");
  if (freeSol !== null && input.feeSol > freeSol) blockers.push("Insufficient unallocated native SOL for the fee envelope.");
  return { activationAllowed: false as const, capitalReady: blockers.length === 0,
    blockers: [...new Set(blockers)], freeUsdc, freeSol,
    allocation: valid ? { BTC: input.baseAllocation, SOL: input.baseAllocation,
      sharedPool: Math.max(0, input.totalCapital - 2 * input.baseAllocation), feeSol: input.feeSol } : null,
    remainingGates: ["Review independent paper cycles and adaptation with open lots.",
      "Reconcile wallet ownership and reserve funds atomically at activation.",
      "Validate live Jupiter costs and explicitly enable the live manager."] };
}
