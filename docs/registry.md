# Registry and deployment

`metadata/metadata.{network}.json` is the source of truth for token metadata,
contract addresses, token IDs, confirmation records, artifact hashes and
maintenance-authority status. Consumers must validate the file and require
registry `status` `ready`. Each token must select exactly one `active`
deployment through `activeDeploymentId`. Replacements retain their prior
records as `superseded` history.

Amounts are exact base-10 strings. Use `BigInt(record.faucet.baseUnits)`, not a
JavaScript `number`. The browser-safe `validateRegistry(value,
expectedNetwork)` export rejects malformed or wrong-network data without
throwing. The JSON Schema provides the build-time structural gate.

## Local deployment

The commands connect to an existing node, indexer and compatible proof server.
They accept a funded wallet seed only through a private file; they never write
the seed into metadata or deployment journals. The file must contain exactly
32 bytes of hexadecimal text. Keep it outside the repository with owner-only
permissions.

Midnight 1.x uses the root dependency context:

```sh
npm ci --ignore-scripts
MN_NETWORK=undeployed \
MN_SEED_FILE=/secure/path/deployer-seed.hex \
MN_NODE_URL=http://127.0.0.1:9944 \
MN_NODE_WS_URL=ws://127.0.0.1:9944 \
MN_INDEXER_URL=http://127.0.0.1:8088/api/v4/graphql \
MN_INDEXER_WS_URL=ws://127.0.0.1:8088/api/v4/graphql/ws \
MN_PROOF_SERVER_URL=http://127.0.0.1:6300 \
npm run deploy:v1
```

Midnight 2.x has an isolated prerelease dependency context:

```sh
npm --prefix contracts/v2 ci --ignore-scripts
MN_NETWORK=undeployed \
MN_SEED_FILE=/secure/path/deployer-seed.hex \
MN_NODE_URL=http://127.0.0.1:9944 \
MN_NODE_WS_URL=ws://127.0.0.1:9944 \
MN_INDEXER_URL=http://127.0.0.1:8088/api/v4/graphql \
MN_INDEXER_WS_URL=ws://127.0.0.1:8088/api/v4/graphql/ws \
MN_PROOF_SERVER_URL=http://127.0.0.1:6300 \
npm --prefix contracts/v2 run deploy
```

Each command obtains the chain name, runtime version and genesis hash from the
node. It uses those values for an isolated stack identity and resume journal,
then processes the six tokens in canonical order. A prior confirmed contract
is resumed only after its complete on-chain verifier-key set, immutable
metadata and derived token ID pass again. A missing or mismatched contract is
treated as stale and requires an explicit `MN_REDEPLOY_STALE=1` retry after the
operator confirms a reset or mismatch. A deployment intent is written to the
private journal before submission. Once a deployment finalizes, its address,
transaction and confirmation are journaled before post-deployment verification,
so a restart verifies that exact address instead of deploying a replacement.
If a deploy call times out before returning its address, the journal keeps an
uncertain in-flight marker and the next run refuses to submit again. Reconcile
the node and indexer first; set `MN_CONFIRM_NO_DEPLOYMENT=1` only after proving
that no deployment finalized. The final registry is written only after every
token passes, under an exclusive writer lock, with file and directory sync
before the atomic rename.

If a deployment process is killed, a stale `.lock` file can remain beside the
registry or private journal. Read the PID stored in the lock, confirm that no
process with that PID is running, and then remove the lock manually. Never
remove a lock owned by a live process; the tooling deliberately does not steal
locks because two writers could otherwise publish conflicting state.

The output is `metadata/metadata.undeployed.json`. It has the same schema as
the tracked public files and is gitignored. Local services and the website can
mount or read that path directly. Do not copy local addresses into source
constants.

## Read-only verification

Verification needs an indexer, but no wallet or seed. It compares every local
verifier key with chain state, rejects missing or extra circuits, checks
immutable metadata, derives the token ID from the final contract address and
requires the recorded ID to match:

```sh
MN_NETWORK=undeployed \
MN_INDEXER_URL=http://127.0.0.1:8088/api/v4/graphql \
MN_INDEXER_WS_URL=ws://127.0.0.1:8088/api/v4/graphql/ws \
npm run verify:v1

MN_NETWORK=undeployed \
MN_INDEXER_URL=http://127.0.0.1:8088/api/v4/graphql \
MN_INDEXER_WS_URL=ws://127.0.0.1:8088/api/v4/graphql/ws \
npm --prefix contracts/v2 run verify
```

For public v1 deployments, set `MN_NETWORK=preview` or `preprod`; the runner
uses the official public RPC and indexer defaults and requires access to a
compatible proof server for deployment. For v2 Stagenet, set
`MN_NETWORK=stagenet`; defaults are
`https://rpc.stagenet.shielded.tools`,
`https://indexer.stagenet.shielded.tools/api/v4/graphql`, and the corresponding
WebSocket endpoints. Set `MN_PROOF_SERVER_URL` to an accessible compatible
9.0.0-rc.5 proof server. Public deployment additionally requires a privately
configured funded wallet.

## Issuer interface

Both protocol packages expose immutable constructor metadata and `name()`,
`symbol()`, `decimals()`, and `tokenColor()` operations. Shielded `mint`
accepts `Either<ZswapCoinPublicKey, ContractAddress>`, a positive caller-chosen
`Uint<64>` amount and a unique `Bytes<32>` nonce. Unshielded `mint` accepts
`Either<ContractAddress, UserAddress>` and a positive caller-chosen `Uint<64>`
amount. The different union ordering is intentional.

For a third-party shielded user, transaction construction must include the
recipient's coin public key and encryption public key in
`additionalCoinEncPublicKeyMappings`. Midnight.js then creates the normal
encrypted Zswap output, allowing that wallet to decrypt and discover the token
through its regular chain scan. Treat the unproven transaction, nonce, coin
information and key mapping as private. Log only finalized public transaction
and contract identifiers. Contract recipients require a composed receiver call;
the exact fixture flow is documented in
[`test/receiver-transaction-composition.md`](../test/receiver-transaction-composition.md).

## Static publication

Static hosting serves the tracked files at `/metadata.preview.json`,
`/metadata.preprod.json`, and `/metadata.stagenet.json` with JSON content type
and cross-origin reads enabled. Those files stay `unavailable` until a funded
public deployment and the read-only verification pass complete. Canonical
addresses are committed only after that evidence. The local undeployed file is
excluded from public static output.
