// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const profile = process.env.RECEIVER_PROFILE?.trim();
assert.ok(profile === "v1" || profile === "v2", "RECEIVER_PROFILE must be v1 or v2");
const root = resolve(
  process.env.MN_REPO_ROOT ??
    resolve(dirname(fileURLToPath(import.meta.url)), ".."),
);

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};

const [
  { CompiledContract },
  ledger,
  {
    createUnprovenCallTx,
    deployContract,
    getPublicStates,
    submitTx,
  },
  { httpClientProofProvider },
  { setNetworkId },
  { NodeZkConfigProvider },
  { ZKConfigProvider },
  { initializeMidnightProviders, MidnightWalletProvider },
  walletSdk,
  { default: pino },
  { filter, firstValueFrom, timeout },
] = await Promise.all([
  import("@midnight-ntwrk/compact-js"),
  import(profile === "v1" ? "@midnight-ntwrk/ledger-v8" : "@midnightntwrk/ledger-v9"),
  import("@midnight-ntwrk/midnight-js-contracts"),
  import("@midnight-ntwrk/midnight-js-http-client-proof-provider"),
  import("@midnight-ntwrk/midnight-js-network-id"),
  import("@midnight-ntwrk/midnight-js-node-zk-config-provider"),
  import("@midnight-ntwrk/midnight-js-types"),
  import("@midnight-ntwrk/testkit-js"),
  import(profile === "v1" ? "@midnight-ntwrk/wallet-sdk" : "@midnightntwrk/wallet-sdk"),
  import("pino"),
  import("rxjs"),
]);

const managedModule = (kind) =>
  pathToFileURL(
    resolve(root, `contracts/${profile}/managed/${kind}/contract/index.js`),
  ).href;
const Receiver = await import(managedModule("receiver"));
const ShieldedIssuer = await import(managedModule("shielded"));
const UnshieldedIssuer = await import(managedModule("unshielded"));

const registryFile = resolve(required("MN_REGISTRY_FILE"));
const seed = (await readFile(resolve(required("MN_SEED_FILE")), "utf8")).trim();
if (!/^[0-9a-f]{64}$/i.test(seed)) {
  throw new Error("Seed file must contain exactly 32 bytes of hex");
}

const env = {
  walletNetworkId: walletSdk.NetworkId.NetworkId.Undeployed,
  networkId: "undeployed",
  indexer: required("MN_INDEXER_URL"),
  indexerWS: required("MN_INDEXER_WS_URL"),
  node: required("MN_NODE_URL"),
  nodeWS: required("MN_NODE_WS_URL"),
  proofServer: required("MN_PROOF_SERVER_URL"),
  faucet: undefined,
};
const timeoutMs = Number(process.env.MN_TIMEOUT_MS ?? 300_000);
assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, "MN_TIMEOUT_MS must be a positive integer");
const runId = `${profile}-${process.pid}-${Date.now()}`;
const stateRoot = resolve(process.env.MN_STATE_ROOT ?? resolve(root, `.local/receiver-all-symbols-${runId}`));
await mkdir(stateRoot, { recursive: true });
const logger = pino({ level: "silent" });

const expectedCatalog = new Map([
  ["twBTC", { privacy: "shielded", amount: 100_000_000n }],
  ["twETH", { privacy: "shielded", amount: 5_000_000_000_000_000_000n }],
  ["twUSDC", { privacy: "shielded", amount: 10_000_000_000n }],
  ["twUSDM", { privacy: "shielded", amount: 10_000_000_000n }],
  ["utwUSDC", { privacy: "unshielded", amount: 10_000_000_000n }],
  ["utwBTC", { privacy: "unshielded", amount: 100_000_000n }],
]);
const requestedSymbols = (process.env.MN_TOKEN_SYMBOLS?.trim() ||
  [...expectedCatalog.keys()].join(","))
  .split(",")
  .map((symbol) => symbol.trim())
  .filter(Boolean);
assert.equal(new Set(requestedSymbols).size, requestedSymbols.length, "MN_TOKEN_SYMBOLS contains duplicates");
for (const symbol of requestedSymbols) {
  assert.ok(expectedCatalog.has(symbol), `unknown token symbol: ${symbol}`);
}
assert.ok(requestedSymbols.length > 0, "MN_TOKEN_SYMBOLS selected no tokens");

const withTimeout = async (label, promise) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const bytes32 = (text) => {
  const encoded = new TextEncoder().encode(text);
  if (encoded.length > 32) throw new Error(`value exceeds 32 bytes: ${text}`);
  const result = new Uint8Array(32);
  result.set(encoded);
  return result;
};

const hexBytes = (value) =>
  Uint8Array.from(Buffer.from(value.replace(/^0x/, ""), "hex"));

const hexField = (value) => {
  const encoded = hexBytes(value);
  assert.ok(encoded.length > 0, "empty serialized field");
  const mode = encoded[0] & 0b11;
  if (mode === 0b11) {
    const payloadLength = (encoded[0] >> 2) + 4;
    assert.equal(encoded.length, payloadLength + 1, "invalid SCALE field length");
    const littleEndian = encoded.slice(1);
    const decoded = BigInt(
      `0x${Buffer.from(littleEndian).reverse().toString("hex") || "0"}`,
    );
    assert.ok(decoded <= ledger.maxField(), "decoded field exceeds scalar modulus");
    return decoded;
  }
  const encodedLength = 1 << mode;
  assert.equal(encoded.length, encodedLength, "invalid compact SCALE field length");
  let compact = 0n;
  for (let index = encodedLength - 1; index >= 0; index -= 1) {
    compact = (compact << 8n) | BigInt(encoded[index]);
  }
  return compact >> 2n;
};

const rpc = async (method, params = []) => {
  const response = await withTimeout(
    `node RPC ${method}`,
    fetch(env.node, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
    }),
  );
  assert.ok(response.ok, `node RPC ${method} returned HTTP ${response.status}`);
  const payload = await response.json();
  assert.equal(payload.error, undefined, `node RPC ${method} failed: ${JSON.stringify(payload.error)}`);
  return payload.result;
};

const protocolFamily = profile === "v1" ? "midnight-1.x" : "midnight-2.x";
const [runtimeVersion, chainId, genesisHash] = await Promise.all([
  rpc("system_version"),
  rpc("system_chain"),
  rpc("chain_getBlockHash", [0]),
]);
const stackPrefix = `${runtimeVersion}:${genesisHash}:`;
const registry = JSON.parse(await readFile(registryFile, "utf8"));
assert.equal(registry.network.key, "undeployed", "receiver all-symbol tests require undeployed metadata");

const definitions = requestedSymbols.map((symbol) => {
  const expected = expectedCatalog.get(symbol);
  const definition = registry.tokens.find((token) => token.symbol === symbol);
  assert.ok(definition, `registry is missing ${symbol}`);
  assert.equal(definition.privacy, expected.privacy, `${symbol} privacy drift`);
  assert.equal(BigInt(definition.faucet.baseUnits), expected.amount, `${symbol} faucet amount drift`);
  const deployments = definition.deployments
    .filter(
      (candidate) =>
        candidate.network.protocolFamily === protocolFamily &&
        candidate.network.chainId === chainId &&
        candidate.network.stackIdentity.startsWith(stackPrefix),
    )
    .sort((left, right) =>
      String(right.verifiedAt ?? right.deployedAt).localeCompare(
        String(left.verifiedAt ?? left.deployedAt),
      ),
    );
  assert.ok(
    deployments.length > 0,
    `registry has no ${symbol} issuer for ${protocolFamily} on ${runtimeVersion}/${genesisHash}`,
  );
  const deployment = deployments[0];
  const computedTokenId = ledger.rawTokenType(
    bytes32(definition.domainSeparator),
    deployment.contractAddress,
  );
  assert.equal(computedTokenId, deployment.tokenId, `${symbol} token ID drift`);
  return {
    symbol,
    privacy: expected.privacy,
    amount: expected.amount,
    domainSeparator: definition.domainSeparator,
    issuerAddress: deployment.contractAddress,
    tokenId: deployment.tokenId,
  };
});

const managedRoot = resolve(root, `contracts/${profile}/managed`);
const shieldedPath = resolve(managedRoot, "shielded");
const unshieldedPath = resolve(managedRoot, "unshielded");
const receiverPath = resolve(managedRoot, "receiver");
const shieldedCompiled = CompiledContract.make(
  "receiver-all-symbols-shielded-issuer",
  ShieldedIssuer.Contract,
).pipe(
  CompiledContract.withVacantWitnesses,
  CompiledContract.withCompiledFileAssets(shieldedPath),
);
const unshieldedCompiled = CompiledContract.make(
  "receiver-all-symbols-unshielded-issuer",
  UnshieldedIssuer.Contract,
).pipe(
  CompiledContract.withVacantWitnesses,
  CompiledContract.withCompiledFileAssets(unshieldedPath),
);
const receiverCompiled = CompiledContract.make(
  "receiver-all-symbols-fixture",
  Receiver.Contract,
).pipe(
  CompiledContract.withVacantWitnesses,
  CompiledContract.withCompiledFileAssets(receiverPath),
);

class RoutingZkConfigProvider extends ZKConfigProvider {
  constructor(route) {
    super();
    this.route = route;
  }

  getProverKey(circuitId) {
    return this.route(circuitId).getProverKey(circuitId);
  }

  getVerifierKey(circuitId) {
    return this.route(circuitId).getVerifierKey(circuitId);
  }

  getZKIR(circuitId) {
    return this.route(circuitId).getZKIR(circuitId);
  }
}

const callPrototype = (
  address,
  circuitId,
  state,
  call,
  communicationRandomness,
) => {
  const operation = ledger.ContractState.deserialize(state.serialize()).operation(circuitId);
  assert.ok(operation, `missing ${circuitId} operation at ${address}`);
  return new ledger.ContractCallPrototype(
    address,
    circuitId,
    operation,
    call.public.partitionedTranscript[0],
    call.public.partitionedTranscript[1],
    call.private.privateTranscriptOutputs,
    call.private.input,
    call.private.output,
    communicationRandomness,
    circuitId,
  );
};

const callCommitment = (prototype) => {
  const probe = ledger.Intent.new(new Date(Date.now() + 60 * 60 * 1_000)).addCall(prototype);
  assert.equal(probe.actions.length, 1, "issuer commitment probe must contain one call");
  const call = probe.actions[0];
  assert.ok("communicationCommitment" in call, "issuer action must be a contract call");
  return call.communicationCommitment;
};

const composeClaimedIssuerCall = (
  issuerCallPrototype,
  issuerCallCommitment,
  receiverAddress,
  receiverState,
  receiverCircuitId,
  receiverCall,
) => {
  const receiverTx = receiverCall.private.unprovenTx;
  const fallibleOffers = [...(receiverTx.fallibleOffer?.values() ?? [])];
  assert.ok(fallibleOffers.length <= 1, "single receiver call must have at most one fallible offer");
  const intent = ledger.Intent.new(new Date(Date.now() + 60 * 60 * 1_000))
    .addCall(issuerCallPrototype)
    .addCall(
      callPrototype(
        receiverAddress,
        receiverCircuitId,
        receiverState,
        receiverCall,
        ledger.communicationCommitmentRandomness(),
      ),
    );
  const realIssuerCalls = intent.actions.filter(
    (action) =>
      "communicationCommitment" in action &&
      action.communicationCommitment === issuerCallCommitment,
  );
  assert.equal(
    realIssuerCalls.length,
    1,
    "final intent must contain exactly one issuer call with the claimed commitment",
  );
  return ledger.Transaction.fromPartsRandomized(
    env.networkId,
    receiverTx.guaranteedOffer,
    fallibleOffers[0],
    intent,
  );
};

const walletBalance = async (wallet, privacy, tokenId) => {
  const state = await firstValueFrom(
    wallet.wallet.state().pipe(
      filter((candidate) => candidate.isSynced),
      timeout({ first: timeoutMs }),
    ),
  );
  return privacy === "shielded"
    ? (state.shielded.balances[tokenId] ?? 0n)
    : (state.unshielded.balances[tokenId] ?? 0n);
};

const waitForWalletBalance = async (wallet, privacy, tokenId, expected) =>
  firstValueFrom(
    wallet.wallet.state().pipe(
      filter((state) => {
        if (!state.isSynced) return false;
        const actual =
          privacy === "shielded"
            ? (state.shielded.balances[tokenId] ?? 0n)
            : (state.unshielded.balances[tokenId] ?? 0n);
        return actual === expected;
      }),
      timeout({ first: timeoutMs }),
    ),
  );

const signerWallet = await withTimeout(
  "signer wallet build",
  MidnightWalletProvider.build(logger, env, seed),
);
const recipientWallet = await withTimeout(
  "recipient wallet build",
  MidnightWalletProvider.build(logger, env, randomBytes(32).toString("hex")),
);

setNetworkId("undeployed");
await withTimeout("signer wallet start", signerWallet.start(true));
await withTimeout("recipient wallet start", recipientWallet.start(false));

const results = [];
try {
  const provider = (zkConfigPath, label) =>
    initializeMidnightProviders(signerWallet, env, {
      privateStateStoreName: resolve(stateRoot, label),
      zkConfigPath,
    });
  const shieldedProviders = provider(shieldedPath, "shielded-issuer");
  const unshieldedProviders = provider(unshieldedPath, "unshielded-issuer");
  const receiverProviders = provider(receiverPath, "receiver");

  const receiverDeploy = await withTimeout(
    "receiver deploy",
    deployContract(receiverProviders, {
      compiledContract: receiverCompiled,
      args: [],
    }),
  );
  const receiverAddress = receiverDeploy.deployTxData.public.contractAddress;
  const receiverAddressBytes = ledger.encodeContractAddress(receiverAddress);
  const receiverDeployTxId = receiverDeploy.deployTxData.public.txId ?? null;
  console.log(
    JSON.stringify({
      checkpoint: "receiverDeployed",
      profile,
      receiverAddress,
      txId: receiverDeployTxId,
      symbols: requestedSymbols,
    }),
  );

  const zeroBytes = new Uint8Array(32);
  const recipientCoinPublicKey = recipientWallet.getCoinPublicKey();
  const recipientUnshieldedAddress = recipientWallet.unshieldedKeystore.getAddress();
  const receiverZk = new NodeZkConfigProvider(receiverPath);

  for (const token of definitions) {
    const issuerPath = token.privacy === "shielded" ? shieldedPath : unshieldedPath;
    const issuerCompiled =
      token.privacy === "shielded" ? shieldedCompiled : unshieldedCompiled;
    const issuerProviders =
      token.privacy === "shielded" ? shieldedProviders : unshieldedProviders;
    const receiveCircuit =
      token.privacy === "shielded"
        ? "receiveShieldedTokenFromIssuer"
        : "receiveUnshieldedTokenFromIssuer";
    const spendCircuit =
      token.privacy === "shielded"
        ? "spendShieldedToken"
        : "spendUnshieldedToken";
    const issuerState = (
      await withTimeout(
        `${token.symbol} issuer state`,
        getPublicStates(issuerProviders.publicDataProvider, token.issuerAddress),
      )
    ).contractState;
    const receiverState = (
      await withTimeout(
        `${token.symbol} receiver state`,
        getPublicStates(receiverProviders.publicDataProvider, receiverAddress),
      )
    ).contractState;
    const beforeRecipientBalance = await walletBalance(
      recipientWallet,
      token.privacy,
      token.tokenId,
    );
    const mintArgs =
      token.privacy === "shielded"
        ? [
            {
              is_left: false,
              left: { bytes: zeroBytes },
              right: { bytes: receiverAddressBytes },
            },
            token.amount,
            Uint8Array.from(randomBytes(32)),
          ]
        : [
            {
              is_left: true,
              left: { bytes: receiverAddressBytes },
              right: { bytes: zeroBytes },
            },
            token.amount,
          ];
    const mint = await withTimeout(
      `${token.symbol} mint call construction`,
      createUnprovenCallTx(issuerProviders, {
        compiledContract: issuerCompiled,
        contractAddress: token.issuerAddress,
        circuitId: "mint",
        args: mintArgs,
      }),
    );
    const issuerCallPrototype = callPrototype(
      token.issuerAddress,
      "mint",
      issuerState,
      mint,
      ledger.communicationCommitmentRandomness(),
    );
    const issuerCallCommitment = callCommitment(issuerCallPrototype);
    const receiveArgs =
      token.privacy === "shielded"
        ? [
            ledger.encodeContractAddress(token.issuerAddress),
            hexBytes(ledger.entryPointHash("mint")),
            hexField(issuerCallCommitment),
            mint.private.result,
          ]
        : [
            ledger.encodeContractAddress(token.issuerAddress),
            hexBytes(ledger.entryPointHash("mint")),
            hexField(issuerCallCommitment),
            mint.private.result,
            token.amount,
          ];
    const receive = await withTimeout(
      `${token.symbol} receive call construction`,
      createUnprovenCallTx(receiverProviders, {
        compiledContract: receiverCompiled,
        contractAddress: receiverAddress,
        circuitId: receiveCircuit,
        args: receiveArgs,
      }),
    );
    if (token.privacy === "unshielded") {
      assert.equal(
        Buffer.from(mint.private.result).toString("hex"),
        token.tokenId,
        `${token.symbol} mint color differs from registry token ID`,
      );
    }

    const issuerZk = new NodeZkConfigProvider(issuerPath);
    const routingZk = new RoutingZkConfigProvider((circuitId) =>
      circuitId === "mint" ? issuerZk : receiverZk,
    );
    const receipt = await withTimeout(
      `${token.symbol} merged mint and receive`,
      submitTx(
        {
          ...issuerProviders,
          zkConfigProvider: routingZk,
          proofProvider: httpClientProofProvider(env.proofServer, routingZk),
        },
        {
          unprovenTx: composeClaimedIssuerCall(
            issuerCallPrototype,
            issuerCallCommitment,
            receiverAddress,
            receiverState,
            receiveCircuit,
            receive,
          ),
          circuitId: ["mint", receiveCircuit],
        },
      ),
    );

    const color =
      token.privacy === "shielded" ? undefined : mint.private.result;
    const receivedBalanceCall = await withTimeout(
      `${token.symbol} receiver balance after receipt`,
      createUnprovenCallTx(receiverProviders, {
        compiledContract: receiverCompiled,
        contractAddress: receiverAddress,
        circuitId:
          token.privacy === "shielded"
            ? "getShieldedBalance"
            : "getUnshieldedBalance",
        ...(color === undefined ? {} : { args: [color] }),
      }),
    );
    assert.equal(
      receivedBalanceCall.private.result,
      token.amount,
      `${token.symbol} receiver balance after receipt`,
    );
    console.log(
      JSON.stringify({
        checkpoint: "received",
        profile,
        symbol: token.symbol,
        privacy: token.privacy,
        amount: token.amount.toString(),
        issuerAddress: token.issuerAddress,
        tokenId: token.tokenId,
        receiverAddress,
        receiptTxId: receipt.txId,
        receiverBalance: receivedBalanceCall.private.result.toString(),
        recipientBalanceBefore: beforeRecipientBalance.toString(),
      }),
    );

    const spendArgs =
      token.privacy === "shielded"
        ? [
            {
              is_left: true,
              left: {
                bytes: Uint8Array.from(Buffer.from(recipientCoinPublicKey, "hex")),
              },
              right: { bytes: zeroBytes },
            },
            token.amount,
          ]
        : [
            {
              is_left: false,
              left: { bytes: zeroBytes },
              right: {
                bytes: Uint8Array.from(Buffer.from(recipientUnshieldedAddress, "hex")),
              },
            },
            color,
            token.amount,
          ];
    const spend = await withTimeout(
      `${token.symbol} spend call construction`,
      createUnprovenCallTx(receiverProviders, {
        compiledContract: receiverCompiled,
        contractAddress: receiverAddress,
        circuitId: spendCircuit,
        args: spendArgs,
        ...(token.privacy === "shielded"
          ? {
              additionalCoinEncPublicKeyMappings: new Map([
                [recipientCoinPublicKey, recipientWallet.getEncryptionPublicKey()],
              ]),
            }
          : {}),
      }),
    );
    const spendTx = await withTimeout(
      `${token.symbol} spend submit`,
      submitTx(receiverProviders, {
        unprovenTx: spend.private.unprovenTx,
        circuitId: spendCircuit,
      }),
    );
    const expectedRecipientBalance = beforeRecipientBalance + token.amount;
    await waitForWalletBalance(
      recipientWallet,
      token.privacy,
      token.tokenId,
      expectedRecipientBalance,
    );
    const discoveredBalance = await walletBalance(
      recipientWallet,
      token.privacy,
      token.tokenId,
    );
    assert.equal(
      discoveredBalance,
      expectedRecipientBalance,
      `${token.symbol} separate-wallet discovery balance`,
    );
    const zeroBalanceCall = await withTimeout(
      `${token.symbol} receiver balance after spend`,
      createUnprovenCallTx(receiverProviders, {
        compiledContract: receiverCompiled,
        contractAddress: receiverAddress,
        circuitId:
          token.privacy === "shielded"
            ? "getShieldedBalance"
            : "getUnshieldedBalance",
        ...(color === undefined ? {} : { args: [color] }),
      }),
    );
    assert.equal(zeroBalanceCall.private.result, 0n, `${token.symbol} receiver not empty`);

    const result = {
      symbol: token.symbol,
      privacy: token.privacy,
      amount: token.amount.toString(),
      issuerAddress: token.issuerAddress,
      tokenId: token.tokenId,
      receiverAddress,
      receiptTxId: receipt.txId,
      spendTxId: spendTx.txId,
      receiverBalanceAfterReceipt: token.amount.toString(),
      receiverBalanceAfterSpend: "0",
      recipientBalanceBefore: beforeRecipientBalance.toString(),
      recipientBalanceAfter: discoveredBalance.toString(),
      recipientBalanceDelta: token.amount.toString(),
    };
    results.push(result);
    console.log(JSON.stringify({ checkpoint: "spentAndDiscovered", profile, ...result }));
  }

  console.log(
    JSON.stringify({
      checkpoint: "allSymbolsComplete",
      profile,
      protocolFamily,
      runtimeVersion,
      chainId,
      genesisHash,
      receiverAddress,
      receiverDeployTxId,
      selectedSymbols: requestedSymbols,
      allSix: requestedSymbols.length === expectedCatalog.size,
      results,
    }),
  );
} finally {
  await Promise.allSettled([recipientWallet.stop(), signerWallet.stop()]);
}
