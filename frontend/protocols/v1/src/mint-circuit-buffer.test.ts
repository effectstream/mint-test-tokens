// @vitest-environment node
//
// Browser-condition regression test for the Midnight 1.x `mint` circuits.
//
// The suite's default jsdom environment runs in its own `vm` realm, so a `Uint8Array`
// created here is rejected by the runtime's WASM bindings ("invalid type:
// JsValue(Uint8Array), expected byte array"). Circuit execution therefore runs in the
// node environment; the browser condition under test is the missing `Buffer` global,
// which is removed explicitly below.
//
// Vitest runs under Node, where `Buffer` is always a global, so the deployed defect
// (`Error executing circuit 'mint' · Buffer is not defined`) was invisible to the suite.
// These tests delete the Node global first, execute the real generated issuer contracts
// against this profile's pinned Compact runtime, and prove both the failure without the
// site's shim and the success with it.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createCircuitContext,
  createConstructorContext,
  encodeCoinPublicKey,
  encodeUserAddress,
  sampleContractAddress,
} from '@midnight-ntwrk/compact-runtime';
import * as Shielded from '../../../../contracts/v1/managed/shielded/contract/index.js';
import * as Unshielded from '../../../../contracts/v1/managed/unshielded/contract/index.js';

// The generated declarations live outside this package and see the root workspace's
// Compact runtime types, so keep the same nominal-type isolation the adapter uses at this
// profile boundary. Vite (production) and `profileRuntimeResolution` (Vitest) bind the
// generated runtime import to this package's exact pinned runtime.
type Recipient = { is_left: boolean; left: { bytes: Uint8Array }; right: { bytes: Uint8Array } };
type ZswapState = { outputs: unknown[] };
type CircuitResults<R> = { result: R; context: { currentZswapLocalState: ZswapState } };
type ShieldedCoin = { nonce: Uint8Array; color: Uint8Array; value: bigint };

interface IssuerContract<R> {
  initialState(
    context: unknown,
    name: string,
    symbol: string,
    decimals: bigint,
    domain: Uint8Array,
  ): { currentZswapLocalState: unknown; currentContractState: unknown; currentPrivateState: unknown };
  impureCircuits: { mint(context: unknown, ...args: unknown[]): CircuitResults<R> };
}

type IssuerConstructor<R> = new (witnesses: Record<string, never>) => IssuerContract<R>;

const runtime = {
  createConstructorContext: createConstructorContext as unknown as (
    privateState: unknown,
    coinPublicKey: string,
  ) => unknown,
  createCircuitContext: createCircuitContext as unknown as (
    contractAddress: string,
    zswapLocalState: unknown,
    contractState: unknown,
    privateState: unknown,
  ) => unknown,
  encodeCoinPublicKey: encodeCoinPublicKey as unknown as (hex: string) => Uint8Array,
  encodeUserAddress: encodeUserAddress as unknown as (hex: string) => Uint8Array,
  sampleContractAddress: sampleContractAddress as unknown as () => string,
};

const coinPublicKey = '11'.repeat(32);
const userAddress = '22'.repeat(32);
const amount = 100000000n;
const blank = () => new Uint8Array(32);

function circuitContext<R>(constructor: IssuerConstructor<R>, symbol: string) {
  const contract = new constructor({});
  const initial = contract.initialState(
    runtime.createConstructorContext({}, coinPublicKey),
    'Test Wrapped BTC',
    symbol,
    8n,
    blank(),
  );
  return {
    contract,
    context: runtime.createCircuitContext(
      runtime.sampleContractAddress(),
      initial.currentZswapLocalState,
      initial.currentContractState,
      initial.currentPrivateState,
    ),
  };
}

function mintShielded() {
  const { contract, context } = circuitContext(
    Shielded.Contract as unknown as IssuerConstructor<ShieldedCoin>,
    'twBTC',
  );
  const recipient: Recipient = {
    is_left: true,
    left: { bytes: runtime.encodeCoinPublicKey(coinPublicKey) },
    right: { bytes: blank() },
  };
  return contract.impureCircuits.mint(context, recipient, amount, blank().fill(7));
}

function mintUnshielded() {
  const { contract, context } = circuitContext(
    Unshielded.Contract as unknown as IssuerConstructor<Uint8Array>,
    'utwBTC',
  );
  const recipient: Recipient = {
    is_left: false,
    left: { bytes: blank() },
    right: { bytes: runtime.encodeUserAddress(userAddress) },
  };
  return contract.impureCircuits.mint(context, recipient, amount);
}

const scope = globalThis as unknown as { Buffer?: unknown };

function withoutNodeBuffer<T>(run: () => T): T {
  const nodeBuffer = scope.Buffer;
  delete scope.Buffer;
  expect(typeof scope.Buffer).toBe('undefined');
  try {
    return run();
  } finally {
    scope.Buffer = nodeBuffer;
  }
}

async function installSiteShim() {
  // Re-evaluate the module so every case actually exercises its install branch.
  vi.resetModules();
  await import('../../../src/polyfills');
  expect(typeof scope.Buffer).toBe('function');
}

afterEach(() => {
  vi.resetModules();
});

describe('v1 mint circuits under browser conditions', () => {
  it('fails with the reported error when no Buffer global is installed', () => {
    withoutNodeBuffer(() => {
      expect(() => mintShielded()).toThrow(ReferenceError);
      expect(() => mintShielded()).toThrow(/Buffer is not defined/);
    });
  });

  it('mints a shielded coin once the site shim installs Buffer', async () => {
    const nodeBuffer = scope.Buffer;
    delete scope.Buffer;
    try {
      await installSiteShim();
      expect(scope.Buffer).not.toBe(nodeBuffer);

      const output = mintShielded();
      expect(output.result.value).toBe(amount);
      expect(output.result.color).toHaveLength(32);
      expect(output.context.currentZswapLocalState.outputs).toHaveLength(1);
    } finally {
      scope.Buffer = nodeBuffer;
    }
  });

  it('mints an unshielded balance once the site shim installs Buffer', async () => {
    const nodeBuffer = scope.Buffer;
    delete scope.Buffer;
    try {
      await installSiteShim();

      const output = mintUnshielded();
      expect(output.result).toBeInstanceOf(Uint8Array);
      expect(output.result).toHaveLength(32);
      expect(output.context.currentZswapLocalState.outputs).toHaveLength(0);
    } finally {
      scope.Buffer = nodeBuffer;
    }
  });
});
