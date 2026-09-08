// @vitest-environment node
//
// Browser-condition regression test for the Midnight 2.x `mint` circuit.
//
// Companion to `protocols/v1/src/mint-circuit-buffer.test.ts`: the same missing browser
// `Buffer` global broke this profile's bundle, and the same site shim fixes it. The
// suite's default jsdom environment runs in its own `vm` realm, whose `Uint8Array` the
// runtime's WASM bindings reject, so circuit execution runs in the node environment; the
// browser condition under test is the missing `Buffer` global, removed explicitly below.
import { describe, expect, it, vi } from 'vitest';
import {
  createCircuitContext,
  createConstructorContext,
  encodeCoinPublicKey,
  sampleContractAddress,
} from '@midnight-ntwrk/compact-runtime';
import * as Shielded from '../../../../contracts/v2/managed/shielded/contract/index.js';

// Same nominal-type isolation as the adapter: the generated declarations live outside
// this package and can see another profile's Compact runtime types. `profileRuntimeResolution`
// binds the generated runtime import to this package's pinned 0.19.0 runtime.
type Recipient = { is_left: boolean; left: { bytes: Uint8Array }; right: { bytes: Uint8Array } };
type ShieldedCoin = { nonce: Uint8Array; color: Uint8Array; value: bigint };
type CircuitResults = {
  result: ShieldedCoin;
  context: { callContext: { currentZswapLocalState?: { outputs: unknown[] } } };
};

interface IssuerContract {
  initialState(
    context: unknown,
    name: string,
    symbol: string,
    decimals: bigint,
    domain: Uint8Array,
  ): Promise<{ currentZswapLocalState: unknown; currentContractState: unknown; currentPrivateState: unknown }>;
  impureCircuits: {
    mint(context: unknown, recipient: Recipient, amount: bigint, nonce: Uint8Array): Promise<CircuitResults>;
  };
}

const runtime = {
  createConstructorContext: createConstructorContext as unknown as (
    privateState: unknown,
    coinPublicKey: string,
  ) => unknown,
  createCircuitContext: createCircuitContext as unknown as (
    circuitId: string,
    contractAddress: string,
    zswapLocalState: unknown,
    contractState: unknown,
    privateState: unknown,
  ) => unknown,
  encodeCoinPublicKey: encodeCoinPublicKey as unknown as (hex: string) => Uint8Array,
  sampleContractAddress: sampleContractAddress as unknown as () => string,
};

const IssuerConstructor = Shielded.Contract as unknown as new (
  witnesses: Record<string, never>,
) => IssuerContract;

const coinPublicKey = '11'.repeat(32);
const amount = 100000000n;
const blank = () => new Uint8Array(32);

async function mintShielded() {
  const contract = new IssuerConstructor({});
  const initial = await contract.initialState(
    runtime.createConstructorContext({}, coinPublicKey),
    'Test Wrapped BTC',
    'twBTC',
    8n,
    blank(),
  );
  const context = runtime.createCircuitContext(
    'mint',
    runtime.sampleContractAddress(),
    initial.currentZswapLocalState,
    initial.currentContractState,
    initial.currentPrivateState,
  );
  const recipient: Recipient = {
    is_left: true,
    left: { bytes: runtime.encodeCoinPublicKey(coinPublicKey) },
    right: { bytes: blank() },
  };
  return contract.impureCircuits.mint(context, recipient, amount, blank().fill(7));
}

const scope = globalThis as unknown as { Buffer?: unknown };

describe('v2 mint circuit under browser conditions', () => {
  it('mints a shielded coin once the site shim installs Buffer', async () => {
    const nodeBuffer = scope.Buffer;
    delete scope.Buffer;
    expect(typeof scope.Buffer).toBe('undefined');
    try {
      // Re-evaluate the module so this case actually exercises its install branch.
      vi.resetModules();
      await import('../../../src/polyfills');
      expect(typeof scope.Buffer).toBe('function');
      expect(scope.Buffer).not.toBe(nodeBuffer);

      const output = await mintShielded();
      expect(output.result.value).toBe(amount);
      expect(output.result.color).toHaveLength(32);
      expect(output.context.callContext.currentZswapLocalState?.outputs).toHaveLength(1);
    } finally {
      scope.Buffer = nodeBuffer;
      vi.resetModules();
    }
  });

  it('fails with the reported error when no Buffer global is installed', async () => {
    const nodeBuffer = scope.Buffer;
    delete scope.Buffer;
    expect(typeof scope.Buffer).toBe('undefined');
    try {
      await expect(mintShielded()).rejects.toThrow(/Buffer is not defined/);
    } finally {
      scope.Buffer = nodeBuffer;
    }
  });
});
