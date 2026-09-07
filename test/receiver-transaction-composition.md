# Receiver transaction composition

The receiver contracts are test fixtures with no authorization checks. Deploy one receiver instance per shielded token color. Their purpose is to prove that each issuer can mint to a contract, that the contract can persist the received asset, and that it can spend the asset later.

## Mint and receive in one transaction

An issuer call to `mint` and the matching receiver call must be submitted in one ledger transaction. A shielded issuer contributes the output and its spend claim; `receiveShieldedToken` contributes the matching receive claim and records the qualified coin. An unshielded issuer contributes the output and spend claim; `receiveUnshieldedToken` contributes the receiver input for the same color and amount.

The tempting high-level recipe below is **known invalid for shielded receipt in v1**. It is retained as a regression example because both independently constructed calls add the same Zswap output, and `UnprovenTransaction.merge` keeps both copies. Wallet balancing then sees two outputs backed by one mint and rejects the transaction with an exact one-mint-amount deficit.

```ts
const issuerCall = await createUnprovenCallTx(providers, {
  compiledContract: compiledIssuer,
  contractAddress: issuerAddress,
  circuitId: "mint",
  args: [contractRecipient(receiverAddress), amount, nonce],
});

const receiverCall = await createUnprovenCallTx(providers, {
  compiledContract: compiledReceiver,
  contractAddress: receiverAddress,
  circuitId: "receiveShieldedToken",
  args: [issuerCall.private.result],
});

const unprovenTx = issuerCall.private.unprovenTx.merge(
  receiverCall.private.unprovenTx,
);
await submitTx(providersForBothContracts, { // INVALID for v1 shielded receipt
  unprovenTx,
  circuitId: ["mint", "receiveShieldedToken"],
});
```

The ZK configuration provider passed to `submitTx` must resolve artifacts for both circuit IDs. Implement the router as a `ZKConfigProvider` subclass so its inherited `get(circuitId)` method assembles the prover key, verifier key, and ZKIR; a plain object with only the three individual getters is insufficient for the HTTP proof provider.

Retaining the issuer transaction and adding only the receiver call's intent with `Transaction.addIntent({ tag: "random" }, intent)` is also **not valid**. It deliberately omits the receiver call transaction's independently assembled Zswap offer and therefore advances through wallet balancing and both proofs, but the v1 node rejects the transaction at validation (`1010: Invalid Transaction: Custom error: 186`). Detailed node logs identify the failed invariant as `claimed_calls is not a subset of real_calls`.

The unshielded analogue replaces the receiver call arguments with `[issuerCall.private.result, amount]` and uses `receiveUnshieldedToken` in the circuit ID list. It has no encrypted Zswap output to duplicate, but the independent merge is still **invalid**: both proofs complete and the v1 node rejects the mixed-contract transaction with the same custom error 186. This confirms both privacy modes require a shared cross-contract communication commitment.

Do not use `withContractScopedTransaction` to cache these two calls: the pinned SDK validates one contract-address/private-state identity per scope. Independent `createUnprovenCallTx` results do not create the required communication binding and must not be merged for submission.

## Valid claimed-call construction

The explicit construction below is confirmed on the v1 local chain for shielded receipt and later spend, and for unshielded receipt. The v2 chain regression remains required before using it as a v2 browser path.

1. Build the issuer `mint` with `createUnprovenCallTx` and fetch the issuer's current `ContractState`.
2. Choose `communicationCommitmentRandomness()` and build an issuer `ContractCallPrototype` from the issuer operation, both public partitioned transcripts, private transcript outputs, input, output, and that randomness.
3. Add that prototype to a temporary `Intent` and read the resulting `ContractCall.communicationCommitment`. Use this actual call commitment as the claim value. In pinned ledger-v8, the exported `communicationCommitment(input, output, randomness)` helper produces a different value because it hashes a different aligned representation; `test/receiver-v1-commitment.mjs` locks this behavior. Pinned ledger-v9 currently makes the helper and actual call agree, but the actual-call derivation works for both profiles.
4. SCALE-decode the serialized commitment to a Compact `Field`. Build the receiver call with `receiveShieldedTokenFromIssuer(encodeContractAddress(issuerAddress), entryPointHash("mint"), commitment, issuerCall.private.result)` or `receiveUnshieldedTokenFromIssuer(..., color, amount)`.
5. Rebuild one `Intent` by adding the issuer prototype and receiver prototype. `Intent.addCall` uses the receiver's claim to order the parent and callee. Assert that the final intent contains exactly one issuer call with the claimed commitment.
6. Build the transaction with `Transaction.fromPartsRandomized`, the receiver call transaction's guaranteed/fallible offer, and the combined intent. This retains one shielded output rather than merging the duplicate issuer and receiver offers.
7. Submit once with `circuitId: ["mint", receiverCircuit]` and a routed `ZKConfigProvider` that loads issuer keys for `mint` and receiver keys for the selected `FromIssuer` circuit.

The commitment, randomness, call inputs/outputs, private transcript outputs, coin result, nonce, and unproven transaction remain private construction data. The final contract addresses, token ID, block confirmation, and transaction identifiers are public verification evidence.

The entire `issuerCall`, `receiverCall`, their `private` fields, the unproven transaction, shielded coin result, nonce, and encryption-key mappings are privacy-sensitive. Do not log, serialize, or send them to telemetry. Log only the finalized transaction ID and public contract/token identities after success.

## Later spend

After the receive transaction finalizes, fetch the new receiver contract state before constructing a spend.

- `spendShieldedToken(recipient, amount)` consumes the qualified coin stored with `writeCoin`. A partial spend stores the returned change coin back in the receiver. The returned `ShieldedCoinInfo` is the sent output. For a user recipient, include that user coin public key to encryption public key mapping in transaction construction so a wallet other than the signer can decrypt and discover it.
- `spendUnshieldedToken(recipient, color, amount)` checks `unshieldedBalanceGte` against the start-of-execution contract balance and creates the recipient output.
- A shielded spend to another contract must be composed with that contract's `receiveShieldedToken` call in the same way as mint plus receive.

The `getUnshieldedBalance` circuit imposes an exact start-state balance constraint and is intended only for a read call. Spending uses `unshieldedBalanceGte` so unrelated incoming transactions do not invalidate an equality assumption.
