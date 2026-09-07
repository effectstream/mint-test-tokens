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

A candidate supported construction is to retain the issuer transaction and add only the receiver call's intent with `Transaction.addIntent({ tag: "random" }, intent)`. This deliberately omits the receiver call transaction's independently assembled Zswap offer, leaving one output for the two matching claims. It remains provisional until the local-chain test proves receipt and later spend. The lower-level alternative is to construct both contract call prototypes around one Zswap output, as the ledger composability tests do, or use a supported native cross-contract-call runtime that threads a single offer. The pinned v1 Midnight.js high-level scoped transaction rejects mixed contract identities, and naive merging of independently assembled calls duplicates the output. This repository must not present shielded mint-to-contract as working until the local-chain test demonstrates the single-output construction.

The unshielded analogue replaces the receiver call arguments with `[issuerCall.private.result, amount]` and uses `receiveUnshieldedToken` in the circuit ID list. It has no encrypted Zswap output to duplicate, but still requires live-chain validation before being presented as complete.

Do not use `withContractScopedTransaction` to cache these two calls: the pinned SDK validates one contract-address/private-state identity per scope. Independent `createUnprovenCallTx` results avoid that state-cache mismatch and `UnprovenTransaction.merge` supplies both call intents to one submission.

The entire `issuerCall`, `receiverCall`, their `private` fields, the unproven transaction, shielded coin result, nonce, and encryption-key mappings are privacy-sensitive. Do not log, serialize, or send them to telemetry. Log only the finalized transaction ID and public contract/token identities after success.

## Later spend

After the receive transaction finalizes, fetch the new receiver contract state before constructing a spend.

- `spendShieldedToken(recipient, amount)` consumes the qualified coin stored with `writeCoin`. A partial spend stores the returned change coin back in the receiver. The returned `ShieldedCoinInfo` is the sent output. For a user recipient, include that user coin public key to encryption public key mapping in transaction construction so a wallet other than the signer can decrypt and discover it.
- `spendUnshieldedToken(recipient, color, amount)` checks `unshieldedBalanceGte` against the start-of-execution contract balance and creates the recipient output.
- A shielded spend to another contract must be composed with that contract's `receiveShieldedToken` call in the same way as mint plus receive.

The `getUnshieldedBalance` circuit imposes an exact start-state balance constraint and is intended only for a read call. Spending uses `unshieldedBalanceGte` so unrelated incoming transactions do not invalidate an equality assumption.
