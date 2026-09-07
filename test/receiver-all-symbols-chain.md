# All-symbol receiver chain test

`receiver-all-symbols-chain.mjs` proves the contract-recipient path for the six
canonical test tokens on one protocol profile. It selects existing issuers from
`metadata.undeployed.json` by protocol family and the live node's runtime,
chain, and genesis hash. It deploys one receiver fixture; it does not deploy or
replace issuers.

For each selected symbol the driver:

1. recomputes and checks the registry token ID and exact faucet amount;
2. builds the issuer call and derives the communication commitment from the
   actual `ContractCall`;
3. submits one intent containing the issuer mint and claimed receiver call;
4. checks the receiver holds the exact amount;
5. spends the full balance from the receiver to a distinct randomly seeded
   wallet;
6. checks the receiver is zero and that the distinct wallet's balance changed
   by exactly the faucet amount.

The default symbol order is `twBTC,twETH,twUSDC,twUSDM,utwUSDC,utwBTC`.
`MN_TOKEN_SYMBOLS` accepts a comma-separated subset for a bounded diagnostic
rerun. A complete acceptance run leaves it unset and requires the final
`allSymbolsComplete` checkpoint to contain `"allSix":true`.

## Runtime inputs

The v1 runner must use the repository root `package-lock.json`; v2 must use
`contracts/v2/package-lock.json`. The final managed issuer and receiver
artifacts for the selected profile and the registry must be present below
`MN_REPO_ROOT`. The funded seed is read only from `MN_SEED_FILE` and is never
logged.

Required variables are:

- `RECEIVER_PROFILE=v1|v2`
- `MN_REPO_ROOT`
- `MN_REGISTRY_FILE`
- `MN_SEED_FILE`
- `MN_STATE_ROOT` (use a new writable directory per run)
- `MN_NODE_URL` and `MN_NODE_WS_URL`
- `MN_INDEXER_URL` and `MN_INDEXER_WS_URL`
- `MN_PROOF_SERVER_URL`

`MN_TIMEOUT_MS` defaults to 300 seconds per asynchronous operation. Because
the pinned wallet SDK can spend time in synchronous WASM, wrap the entire
Docker process with an external limit. The verified runs used:

```sh
timeout --signal=TERM --kill-after=30s 2700s \
  node /runner/receiver-all-symbols-chain.mjs
```

The Docker image used for each run was assembled from the matching lockfile and
Node `24.15.0-bookworm`, then copied only the matching final managed artifacts,
the registry snapshot, and this driver. The chain containers remained owned by
the shared stack operator. The receiver runner mounted only a fresh state
directory and the seed file, and its container was removed after exit.

Every `received` and `spentAndDiscovered` line is standalone JSON containing
the profile, symbol, privacy mode, exact amount, issuer and receiver addresses,
token ID, transaction IDs, and observed balances. This preserves attributable
evidence if the outer process limit ends a partial run.
