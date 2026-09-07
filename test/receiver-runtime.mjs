// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const profile = process.env.RECEIVER_PROFILE;
assert.match(profile ?? "", /^v[12]$/, "RECEIVER_PROFILE must be v1 or v2");

const profileRoot = new URL(`../contracts/${profile}/`, import.meta.url);
const receiverModulePath = process.env.RECEIVER_CONTRACT_MODULE ?? new URL("managed/receiver/contract/index.js", profileRoot).href;
const shieldedIssuerModulePath =
  process.env.SHIELDED_ISSUER_CONTRACT_MODULE ?? new URL("managed/shielded/contract/index.js", profileRoot).href;
const unshieldedIssuerModulePath =
  process.env.UNSHIELDED_ISSUER_CONTRACT_MODULE ?? new URL("managed/unshielded/contract/index.js", profileRoot).href;

const packageRoot = process.env.RECEIVER_PACKAGE_ROOT ?? (profile === "v1" ? new URL("..", import.meta.url).pathname : profileRoot.pathname);
const packageRequire = createRequire(pathToFileURL(resolve(packageRoot, "package.json")));
const runtime = await import(pathToFileURL(packageRequire.resolve("@midnight-ntwrk/compact-runtime")).href);
const { Contract: ReceiverContract } = await import(receiverModulePath);
const { Contract: ShieldedIssuerContract } = await import(shieldedIssuerModulePath);
const { Contract: UnshieldedIssuerContract } = await import(unshieldedIssuerModulePath);

const runtimePackage = JSON.parse(await readFile(packageRequire.resolve("@midnight-ntwrk/compact-runtime/package.json"), "utf8"));
const expectedRuntime = profile === "v1" ? "0.16.0" : "0.18.0-rc.1";
assert.equal(runtimePackage.version, expectedRuntime);

const bytes = (fill) => new Uint8Array(32).fill(fill);
const zeroBytes = bytes(0);
const coinPublicKey = { bytes: bytes(3) };
const emptyZswap = () => ({
  coinPublicKey,
  outputs: [],
  inputs: [],
  currentIndex: 0n,
});

const addresses = new Set();
while (addresses.size < 3) addresses.add(runtime.sampleContractAddress());
const [receiverAddress, shieldedIssuerAddress, unshieldedIssuerAddress] = addresses;
const receiverAddressBytes = runtime.encodeContractAddress(receiverAddress);

function context(circuitId, address, state, zswap = coinPublicKey) {
  return profile === "v1"
    ? runtime.createCircuitContext(address, zswap, state, undefined)
    : runtime.createCircuitContext(circuitId, address, zswap, state, undefined);
}

function queryContext(result) {
  return profile === "v1"
    ? result.context.currentQueryContext
    : result.context.callContext.currentQueryContext;
}

function zswapState(result) {
  return profile === "v1"
    ? result.context.currentZswapLocalState
    : result.context.callContext.currentZswapLocalState;
}

const receiver = new ReceiverContract({});
const shieldedIssuer = new ShieldedIssuerContract({});
const unshieldedIssuer = new UnshieldedIssuerContract({});

const receiverInitial = await receiver.initialState({
  initialPrivateState: undefined,
  initialZswapLocalState: emptyZswap(),
});
const shieldedIssuerInitial = await shieldedIssuer.initialState(
  { initialPrivateState: undefined, initialZswapLocalState: emptyZswap() },
  "Test Wrapped Bitcoin",
  "twBTC",
  8n,
  bytes(7),
);
const unshieldedIssuerInitial = await unshieldedIssuer.initialState(
  { initialPrivateState: undefined, initialZswapLocalState: emptyZswap() },
  "Unshielded Test Wrapped Bitcoin",
  "utwBTC",
  8n,
  bytes(8),
);

const receiverRecipient = {
  is_left: false,
  left: { bytes: zeroBytes },
  right: { bytes: receiverAddressBytes },
};
const shieldedUserRecipient = {
  is_left: true,
  left: { bytes: bytes(9) },
  right: { bytes: zeroBytes },
};
const shieldedContractRecipient = {
  is_left: false,
  left: { bytes: zeroBytes },
  right: { bytes: bytes(10) },
};
const unshieldedUserRecipient = {
  is_left: false,
  left: { bytes: zeroBytes },
  right: { bytes: bytes(11) },
};
const zeroShieldedRecipient = {
  is_left: true,
  left: { bytes: zeroBytes },
  right: { bytes: zeroBytes },
};
const zeroUnshieldedRecipient = {
  is_left: false,
  left: { bytes: zeroBytes },
  right: { bytes: zeroBytes },
};

// A shielded issuer output to the receiver and the receiver's claim are the
// matching halves that must be merged into one submitted transaction.
const shieldedMint = await shieldedIssuer.circuits.mint(
  context(
    "mint",
    shieldedIssuerAddress,
    shieldedIssuerInitial.currentContractState,
  ),
  receiverRecipient,
  100n,
  bytes(12),
);
const explicitlyClaimedShieldedReceive = await receiver.circuits.receiveShieldedTokenFromIssuer(
  context(
    "receiveShieldedTokenFromIssuer",
    receiverAddress,
    receiverInitial.currentContractState,
  ),
  runtime.encodeContractAddress(shieldedIssuerAddress),
  bytes(16),
  1n,
  shieldedMint.result,
);
assert.equal(queryContext(explicitlyClaimedShieldedReceive).effects.claimedContractCalls.length, 1);
assert.equal(queryContext(explicitlyClaimedShieldedReceive).effects.claimedContractCalls[0][1], shieldedIssuerAddress);
assert.ok(queryContext(explicitlyClaimedShieldedReceive).effects.claimedContractCalls[0][3].length > 0);
const shieldedReceive = await receiver.circuits.receiveShieldedToken(
  context(
    "receiveShieldedToken",
    receiverAddress,
    receiverInitial.currentContractState,
  ),
  shieldedMint.result,
);
assert.deepEqual(
  queryContext(shieldedMint).effects.claimedShieldedSpends,
  queryContext(shieldedReceive).effects.claimedShieldedReceives,
  "issuer spend claim and receiver receive claim must use the same commitment",
);
assert.equal(zswapState(shieldedMint).outputs.length, 1);
assert.equal(zswapState(shieldedReceive).outputs.length, 1);
assert.deepEqual(
  zswapState(shieldedMint).outputs[0].coinInfo,
  zswapState(shieldedReceive).outputs[0].coinInfo,
);

let receiverState = queryContext(shieldedReceive).state;
let shieldedBalance = await receiver.circuits.getShieldedBalance(
  context("getShieldedBalance", receiverAddress, receiverState),
);
assert.equal(shieldedBalance.result, 100n);

// A second receipt of the same color is merged into the persisted qualified
// coin. A different color is rejected by the one-color fixture invariant.
const secondCoin = { nonce: bytes(13), color: shieldedMint.result.color, value: 50n };
const secondReceive = await receiver.circuits.receiveShieldedToken(
  context("receiveShieldedToken", receiverAddress, receiverState),
  secondCoin,
);
receiverState = queryContext(secondReceive).state;
shieldedBalance = await receiver.circuits.getShieldedBalance(
  context("getShieldedBalance", receiverAddress, receiverState),
);
assert.equal(shieldedBalance.result, 150n);
await assert.rejects(
  Promise.resolve().then(() =>
    receiver.circuits.receiveShieldedToken(
      context("receiveShieldedToken", receiverAddress, receiverState),
      { nonce: bytes(14), color: bytes(15), value: 1n },
    ),
  ),
  /receiver holds another token color/,
);

await assert.rejects(
  Promise.resolve().then(() =>
    receiver.circuits.receiveShieldedToken(
      context("receiveShieldedToken", receiverAddress, receiverState),
      { nonce: bytes(14), color: shieldedMint.result.color, value: 0n },
    ),
  ),
  /amount must be positive/,
);
await assert.rejects(
  Promise.resolve().then(() =>
    receiver.circuits.spendShieldedToken(
      context("spendShieldedToken", receiverAddress, receiverState),
      zeroShieldedRecipient,
      1n,
    ),
  ),
  /invalid recipient/,
);
await assert.rejects(
  Promise.resolve().then(() =>
    receiver.circuits.spendShieldedToken(
      context("spendShieldedToken", receiverAddress, receiverState),
      shieldedUserRecipient,
      151n,
    ),
  ),
  /insufficient shielded balance/,
);

const partialSpend = await receiver.circuits.spendShieldedToken(
  context("spendShieldedToken", receiverAddress, receiverState),
  shieldedUserRecipient,
  40n,
);
assert.equal(partialSpend.result.value, 40n);
assert.equal(zswapState(partialSpend).inputs.length, 1);
assert.equal(zswapState(partialSpend).outputs.length, 2);
assert.equal(zswapState(partialSpend).outputs[0].recipient.is_left, true);
receiverState = queryContext(partialSpend).state;
shieldedBalance = await receiver.circuits.getShieldedBalance(
  context("getShieldedBalance", receiverAddress, receiverState),
);
assert.equal(shieldedBalance.result, 110n);

const finalSpend = await receiver.circuits.spendShieldedToken(
  context("spendShieldedToken", receiverAddress, receiverState),
  shieldedContractRecipient,
  110n,
);
assert.equal(finalSpend.result.value, 110n);
assert.equal(zswapState(finalSpend).outputs.length, 1);
assert.equal(zswapState(finalSpend).outputs[0].recipient.is_left, false);
receiverState = queryContext(finalSpend).state;
shieldedBalance = await receiver.circuits.getShieldedBalance(
  context("getShieldedBalance", receiverAddress, receiverState),
);
assert.equal(shieldedBalance.result, 0n);

// Unshielded mint and receive effects likewise form one balanced transaction.
const unshieldedMint = await unshieldedIssuer.circuits.mint(
  context(
    "mint",
    unshieldedIssuerAddress,
    unshieldedIssuerInitial.currentContractState,
  ),
  {
    is_left: true,
    left: { bytes: receiverAddressBytes },
    right: { bytes: zeroBytes },
  },
  250n,
);
const explicitlyClaimedUnshieldedReceive = await receiver.circuits.receiveUnshieldedTokenFromIssuer(
  context(
    "receiveUnshieldedTokenFromIssuer",
    receiverAddress,
    receiverInitial.currentContractState,
  ),
  runtime.encodeContractAddress(unshieldedIssuerAddress),
  bytes(17),
  2n,
  unshieldedMint.result,
  250n,
);
assert.equal(queryContext(explicitlyClaimedUnshieldedReceive).effects.claimedContractCalls.length, 1);
assert.equal(queryContext(explicitlyClaimedUnshieldedReceive).effects.claimedContractCalls[0][1], unshieldedIssuerAddress);
assert.ok(queryContext(explicitlyClaimedUnshieldedReceive).effects.claimedContractCalls[0][3].length > 0);
const unshieldedReceive = await receiver.circuits.receiveUnshieldedToken(
  context(
    "receiveUnshieldedToken",
    receiverAddress,
    receiverInitial.currentContractState,
  ),
  unshieldedMint.result,
  250n,
);
const mintedToReceiver = [...queryContext(unshieldedMint).effects.claimedUnshieldedSpends.values()];
const receiverInputs = [...queryContext(unshieldedReceive).effects.unshieldedInputs.values()];
assert.deepEqual(mintedToReceiver, [250n]);
assert.deepEqual(receiverInputs, [250n]);

await assert.rejects(
  Promise.resolve().then(() =>
    receiver.circuits.receiveUnshieldedToken(
      context(
        "receiveUnshieldedToken",
        receiverAddress,
        receiverInitial.currentContractState,
      ),
      unshieldedMint.result,
      0n,
    ),
  ),
  /amount must be positive/,
);

// Simulate the next on-chain snapshot after the receive transaction applies.
receiverInitial.currentContractState.balance = new Map([
  [
    {
      tag: "unshielded",
      raw: Buffer.from(unshieldedMint.result).toString("hex"),
    },
    250n,
  ],
]);
const unshieldedBalance = await receiver.circuits.getUnshieldedBalance(
  context(
    "getUnshieldedBalance",
    receiverAddress,
    receiverInitial.currentContractState,
  ),
  unshieldedMint.result,
);
assert.equal(unshieldedBalance.result, 250n);

await assert.rejects(
  Promise.resolve().then(() =>
    receiver.circuits.spendUnshieldedToken(
      context(
        "spendUnshieldedToken",
        receiverAddress,
        receiverInitial.currentContractState,
      ),
      zeroUnshieldedRecipient,
      unshieldedMint.result,
      1n,
    ),
  ),
  /invalid recipient/,
);
await assert.rejects(
  Promise.resolve().then(() =>
    receiver.circuits.spendUnshieldedToken(
      context(
        "spendUnshieldedToken",
        receiverAddress,
        receiverInitial.currentContractState,
      ),
      unshieldedUserRecipient,
      unshieldedMint.result,
      251n,
    ),
  ),
  /insufficient unshielded balance/,
);
const unshieldedSpend = await receiver.circuits.spendUnshieldedToken(
  context(
    "spendUnshieldedToken",
    receiverAddress,
    receiverInitial.currentContractState,
  ),
  unshieldedUserRecipient,
  unshieldedMint.result,
  100n,
);
assert.deepEqual([...queryContext(unshieldedSpend).effects.unshieldedOutputs.values()], [100n]);
assert.deepEqual([...queryContext(unshieldedSpend).effects.claimedUnshieldedSpends.values()], [100n]);

console.log(
  JSON.stringify({
    profile,
    compactRuntime: runtimePackage.version,
    checks: {
      shieldedMintReceiveCommitmentMatch: true,
      shieldedPersistenceMergePartialAndFullSpend: true,
      shieldedUserAndContractRecipients: true,
      unshieldedMintReceiveAmountMatch: true,
      unshieldedBalanceAndSpend: true,
      invalidAmountsColorsRecipientsAndOverspend: true,
    },
  }),
);
