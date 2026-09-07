# Static registry contract

`metadata/metadata.{network}.json` is the source of truth for published token
metadata and deployment identities. Consumers must require registry `status`
`ready` and an `activeDeploymentId` whose deployment is `active` before using
an address or token ID. An unavailable token has no deployments and a null
active ID. Replacements retain superseded history.

Amounts are base-10 integer strings. Use `BigInt(record.faucet.baseUnits)`, not
a JavaScript `number`.

The generated `metadata.undeployed.json` uses this schema and is gitignored.
Local publication is atomic and locked; readers reload complete snapshots and
wait for `status: "ready"`.

## Issuer interface

Both protocol packages expose immutable constructor metadata and `name()`,
`symbol()`, `decimals()`, `tokenColor()` operations. Shielded `mint` accepts
`Either<ZswapCoinPublicKey, ContractAddress>`, positive `Uint<64>` amount and a
unique `Bytes<32>` nonce, and returns coin information for private delivery.
Unshielded `mint` accepts `Either<ContractAddress, UserAddress>` and a positive
`Uint<64>` amount. The different union ordering is intentional.

DApp Connector API v4.0.1 exposes `getShieldedBalances` and
`getUnshieldedBalances` for both protocol profiles. Its shielded address result
contains the full address plus coin and encryption public keys. The standard
API does not currently expose a method to import contract-minted coin info into
a third-party wallet; callers must not label a shielded mint received until a
wallet-supported delivery path has confirmed it.
