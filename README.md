# Midnight test tokens

Native test-token issuers and a canonical, static registry for Preview,
Preprod, Stagenet, and local Midnight stacks.

The registry contract and deployment commands are documented in
[`docs/registry.md`](docs/registry.md). Public files live at
`metadata/metadata.{network}.json`. A local deployment creates
`metadata/metadata.undeployed.json` atomically; that file is deliberately
ignored by Git and is the local integration source of truth. Set
`MN_METADATA_OUTPUT_DIR` to publish the same fixed filename directly into a
stack-specific shared directory or volume.

The contracts expose immutable OpenZeppelin-compatible `name`, `symbol`, and
`decimals` metadata, a final-address-derived `tokenColor`, and a positive,
caller-selected `Uint<64>` mint amount. Website faucet presets are registry
metadata and are not enforced by the contracts.

```sh
npm install
npm run check
```

The static minting directory lives in [`frontend/`](frontend/README.md). It
loads the registry at runtime, connects a compatible Midnight wallet, reads
the exact shielded and unshielded balances, and submits fixed faucet amounts
through isolated Midnight 1.x and 2.x browser adapters.

Release uploads must use the exact-commit Docker export documented in the
[frontend release procedure](frontend/README.md#verified-release-export). Do
not upload `frontend/dist` from a working checkout: it may contain an older host
build even when a disposable Docker gate passed. The publishable directory and
its SHA-256/provenance sidecars identify the source commit that was actually
tested.

A preview may honestly publish registries whose status is `unavailable`, with
no active deployment identities and disabled mint controls. Describe that URL
as an unavailable-token preview. A mint-ready public release requires the
tracked registry and on-chain deployment checks to pass first.
