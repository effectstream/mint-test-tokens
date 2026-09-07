# Midnight test tokens

Native test-token issuers and a canonical, static registry for Preview,
Preprod, Stagenet, and local Midnight stacks.

The registry contract is documented in [`docs/registry.md`](docs/registry.md).
Public files live at `metadata/metadata.{network}.json`. A local deployment
creates `metadata.undeployed.json` atomically; that file is deliberately ignored
by Git.

The contracts expose immutable OpenZeppelin-compatible `name`, `symbol`, and
`decimals` metadata, a final-address-derived `tokenColor`, and a positive,
caller-selected `Uint<64>` mint amount. Website faucet presets are registry
metadata and are not enforced by the contracts.

```sh
npm install
npm run check
```
Native Midnight test tokens, canonical network metadata, and a static minting site
