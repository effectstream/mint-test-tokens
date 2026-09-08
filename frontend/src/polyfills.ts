// Browser runtime shim for the pinned Midnight packages.
//
// `@midnight-ntwrk/compact-runtime` (`toHex`/`fromHex` in `dist/utils.js`, and
// `insertCommitment(Buffer.from(...))` on the shielded-coin path in `dist/zswap.js`),
// `wallet-sdk-address-format`, `platform-js`, `midnight-js-utils` and the indexer
// provider all read the bare Node global `Buffer`. Browsers do not define it, so
// circuit execution failed with `ReferenceError: Buffer is not defined`, surfaced by
// `midnight-js-contracts` as `Error executing circuit 'mint' · Buffer is not defined`.
//
// This module must be the first import of the application entry point so the global
// exists before the lazily imported `protocols/v1|v2` adapter chunks evaluate. Node
// based tests cannot observe the absence of the global, so the regression tests in
// `protocols/v1/src/mint-circuit-buffer.test.ts` and
// `protocols/v2/src/mint-circuit-buffer.test.ts` delete it first.
import { Buffer } from 'buffer';

const scope = globalThis as typeof globalThis & { Buffer?: typeof Buffer };

// Never replace a `Buffer` installed by another script, for example a wallet extension.
if (typeof scope.Buffer === 'undefined') {
  scope.Buffer = Buffer;
}
