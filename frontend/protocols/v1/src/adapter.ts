import type { MintRequest } from '@effectstream/mint-test-token-protocol-interface';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { ContractState } from '@midnight-ntwrk/compact-runtime';
import {
  encodeCoinPublicKey,
  encodeUserAddress,
  type FinalizedTransaction,
  rawTokenType,
  Transaction,
} from '@midnight-ntwrk/ledger-v8';
import { submitCallTxAsync } from '@midnight-ntwrk/midnight-js-contracts';
import { FetchZkConfigProvider } from '@midnight-ntwrk/midnight-js-fetch-zk-config-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { createProofProvider, SucceedEntirely, ZKConfigProvider } from '@midnight-ntwrk/midnight-js-types';
import {
  MidnightBech32m,
  UnshieldedAddress,
} from '@midnight-ntwrk/wallet-sdk-address-format';
import * as Shielded from '../../../../contracts/v1/managed/shielded/contract/index.js';
import * as Unshielded from '../../../../contracts/v1/managed/unshielded/contract/index.js';
import {
  createProtocolAdapter,
  type ProtocolBridge,
  type WalletSessionLike,
} from '../../shared/adapter-core';
import { normalizeShieldedIdentity } from './identity';

const PROFILE = 'v1';
const blank = () => new Uint8Array(32);

// Generated declarations live outside this package and can see another profile's
// Compact runtime while the root workspace is type-checked. Keep that nominal type
// identity at this profile boundary; Vite resolves the generated runtime import to
// this package's exact pinned runtime at build time.
function compileProfileContract(tag: string, contract: unknown, assetPath: string) {
  const make = CompiledContract.make as unknown as (name: string, value: unknown) => any;
  const withAssets = CompiledContract.withCompiledFileAssets as unknown as (path: string) => unknown;
  return make(tag, contract).pipe(
    CompiledContract.withVacantWitnesses,
    withAssets(assetPath),
  );
}

const shieldedContract = compileProfileContract(
  'mint-test-token-v1-shielded',
  Shielded.Contract,
  `./contract/${PROFILE}/shielded`,
);
const unshieldedContract = compileProfileContract(
  'mint-test-token-v1-unshielded',
  Unshielded.Contract,
  `./contract/${PROFILE}/unshielded`,
);
class RoutedZkConfigProvider extends ZKConfigProvider<string> {
  constructor(
    private readonly issuer: FetchZkConfigProvider<string>,
    private readonly receiver: FetchZkConfigProvider<string>,
  ) {
    super();
  }

  private select(circuitId: string) {
    return circuitId.startsWith('receive') ? this.receiver : this.issuer;
  }

  getProverKey(circuitId: string) { return this.select(circuitId).getProverKey(circuitId); }
  getVerifierKey(circuitId: string) { return this.select(circuitId).getVerifierKey(circuitId); }
  getZKIR(circuitId: string) { return this.select(circuitId).getZKIR(circuitId); }
}

function trimHex(value: string): string {
  return value.trim().replace(/^0x/i, '').toLowerCase();
}

function shieldedKeys(request: Extract<MintRequest['recipient'], { kind: 'shielded-user' }>, networkId: string) {
  return normalizeShieldedIdentity(request, networkId);
}

function rawUserAddress(value: string, networkId: string): string {
  const raw = trimHex(value);
  if (/^[0-9a-f]+$/.test(raw)) {
    encodeUserAddress(raw);
    return raw;
  }
  return MidnightBech32m.parse(value).decode(UnshieldedAddress, networkId).hexString;
}

const bridge: ProtocolBridge = {
  protocolFamily: 'midnight-1.x',
  setNetworkId,
  createPublicDataProvider: (indexerUri, indexerWsUri) => indexerPublicDataProvider(indexerUri, indexerWsUri),
  createZkConfigProvider: (baseUrl) => new RoutedZkConfigProvider(
    new FetchZkConfigProvider(baseUrl, window.fetch.bind(window)),
    new FetchZkConfigProvider(`${window.location.origin}/contract/${PROFILE}/receiver`, window.fetch.bind(window)),
  ),
  createProofProvider: (provider) => createProofProvider(provider as Parameters<typeof createProofProvider>[0]),
  deserializeFinalizedTransaction: (bytes) => Transaction.deserialize(
    'signature',
    'proof',
    'binding',
    bytes,
  ) as FinalizedTransaction,
  isSuccessStatus: (status) => status === SucceedEntirely,
  async readMetadata(publicDataProvider, contractAddress) {
    const state = await publicDataProvider.queryContractState(contractAddress);
    if (!state || typeof state !== 'object' || !('serialize' in state)) {
      throw new Error(`No contract state found at ${contractAddress}.`);
    }
    const runtimeState = ContractState.deserialize((state as { serialize(): Uint8Array }).serialize());
    const tryLedger = (decoder: (value: never) => { _name: string; _symbol: string; _decimals: bigint; _domain: Uint8Array }) => {
      const value = decoder(runtimeState.data as never);
      return {
        name: value._name,
        symbol: value._symbol,
        decimals: Number(value._decimals),
        tokenId: rawTokenType(value._domain, contractAddress),
      };
    };
    try {
      return tryLedger(Shielded.ledger);
    } catch {
      return tryLedger(Unshielded.ledger);
    }
  },
  async submitMint(providers, request, networkId) {
    if (request.recipient.kind === 'contract') {
      throw new Error('Minting to contracts is unavailable while that recipient flow completes chain verification.');
    }
    const contractAddress = trimHex(request.contractAddress);
    const submit = submitCallTxAsync as unknown as (
      selectedProviders: Record<string, unknown>,
      options: Record<string, unknown>,
    ) => Promise<{
      txId: string;
      callTxData: { private: { result: unknown } };
    }>;
    if (request.privacy === 'shielded') {
      const nonce = crypto.getRandomValues(new Uint8Array(32));
      const recipient = request.recipient.kind === 'shielded-user'
        ? (() => {
            const keys = shieldedKeys(request.recipient, networkId);
            return {
              value: { is_left: true, left: { bytes: encodeCoinPublicKey(keys.coinKey) }, right: { bytes: blank() } },
              mappings: new Map([[keys.coinKey, keys.encryptionKey]]),
            };
          })()
        : (() => { throw new Error('A shielded token requires a shielded user or contract recipient.'); })();
      const result = await submit(providers, {
        compiledContract: shieldedContract,
        contractAddress,
        circuitId: 'mint',
        args: [recipient.value, request.amount, nonce],
        additionalCoinEncPublicKeyMappings: recipient.mappings,
      });
      return {
        transactionId: result.txId,
        shieldedCoinInfo: result.callTxData.private.result as { nonce: Uint8Array; color: Uint8Array; value: bigint },
      };
    }

    const recipient = request.recipient.kind === 'unshielded-user'
        ? { is_left: false, left: { bytes: blank() }, right: { bytes: encodeUserAddress(rawUserAddress(request.recipient.userAddress, networkId)) } }
        : (() => { throw new Error('An unshielded token requires an unshielded user or contract recipient.'); })();
    const result = await submit(providers, {
      compiledContract: unshieldedContract,
      contractAddress,
      circuitId: 'mint',
      args: [recipient, request.amount],
    });
    return { transactionId: result.txId };
  },
};

export function createV1Adapter(session: WalletSessionLike) {
  const keys = normalizeShieldedIdentity({
    shieldedAddress: session.shieldedAddress,
    coinPublicKey: session.shieldedCoinPublicKey,
    encryptionPublicKey: session.shieldedEncryptionPublicKey,
  }, session.networkId);
  return createProtocolAdapter({
    ...session,
    shieldedCoinPublicKey: keys.coinKey,
    shieldedEncryptionPublicKey: keys.encryptionKey,
  }, bridge);
}
