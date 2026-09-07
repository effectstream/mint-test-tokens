import { describe, expect, it, vi } from 'vitest';
import * as Ledger from '@midnightntwrk/ledger-v9';
import {
  buildClaimedContractMint,
  callCommitment,
  callPrototype,
  hexBytes,
  scaleField,
  type CallOptions,
  type ClaimedCallLedger,
  type RawCall,
} from '../../shared/claimed-call';

const runtime = Ledger as unknown as ClaimedCallLedger;
const networkId = 'undeployed';
const issuerAddress = '33'.repeat(32);
const receiverAddress = '44'.repeat(32);
const input = {
  value: [new Uint8Array()],
  alignment: [{ tag: 'atom', value: { tag: 'field' } }],
} as Ledger.AlignedValue;
const output = {
  value: [new Uint8Array([1, 2])],
  alignment: [{ tag: 'atom', value: { tag: 'compress' } }],
} as Ledger.AlignedValue;

function state(circuitId: string): Ledger.ContractState {
  const value = new Ledger.ContractState();
  value.setOperation(circuitId, new Ledger.ContractOperation());
  return value;
}

function rawCall(result: unknown): RawCall {
  return {
    public: { partitionedTranscript: [undefined, undefined] },
    private: {
      input,
      output,
      privateTranscriptOutputs: [],
      result,
      unprovenTx: Ledger.Transaction.fromPartsRandomized(networkId),
    },
  };
}

describe('v2 claimed receiver composition', () => {
  it.each(['shielded', 'unshielded'] as const)(
    'constructs one actual two-call intent for a %s mint',
    async (privacy) => {
      const issuerResult = privacy === 'shielded'
        ? { nonce: new Uint8Array(32), color: new Uint8Array(32), value: 100n }
        : new Uint8Array(32).fill(7);
      const calls: CallOptions[] = [];
      const receiverCircuit = privacy === 'shielded'
        ? 'receiveShieldedTokenFromIssuer'
        : 'receiveUnshieldedTokenFromIssuer';
      const issuerState = state('mint');
      const receiverState = state(receiverCircuit);
      const readContractState = vi.fn(async (_provider: unknown, address: string) =>
        address === issuerAddress ? issuerState : receiverState,
      );
      const createUnprovenCall = vi.fn(async (_providers: Record<string, unknown>, options: CallOptions) => {
        calls.push(options);
        return rawCall(options.circuitId === 'mint' ? issuerResult : []);
      });
      const nonce = new Uint8Array(32).fill(9);

      const built = await buildClaimedContractMint({
        ledger: runtime,
        networkId,
        privacy,
        amount: 100n,
        issuerAddress,
        receiverAddress,
        compiledIssuer: { kind: 'issuer' },
        compiledReceiver: { kind: 'receiver' },
        providers: {},
        publicDataProvider: {},
        createUnprovenCall,
        readContractState,
        encodeContractAddress: Ledger.encodeContractAddress,
        entryPointHash: Ledger.entryPointHash,
        ...(privacy === 'shielded' ? { nonce } : {}),
      });

      expect(readContractState).toHaveBeenCalledTimes(2);
      expect(calls.map((call) => call.circuitId)).toEqual(['mint', receiverCircuit]);
      expect(built.circuitIds).toEqual(['mint', receiverCircuit]);
      const issuerRecipient = calls[0].args[0] as {
        is_left: boolean;
        left: { bytes: Uint8Array };
        right: { bytes: Uint8Array };
      };
      expect(issuerRecipient.is_left).toBe(privacy === 'unshielded');
      expect(privacy === 'shielded' ? issuerRecipient.right.bytes : issuerRecipient.left.bytes)
        .toEqual(Ledger.encodeContractAddress(receiverAddress));
      expect(calls[0].args).toHaveLength(privacy === 'shielded' ? 3 : 2);
      if (privacy === 'shielded') expect(calls[0].args[2]).toBe(nonce);

      expect(calls[1].args[0]).toEqual(Ledger.encodeContractAddress(issuerAddress));
      expect(calls[1].args[1]).toEqual(hexBytes(Ledger.entryPointHash('mint')));
      expect(calls[1].args[3]).toBe(issuerResult);
      expect(calls[1].args).toHaveLength(privacy === 'shielded' ? 4 : 5);
      if (privacy === 'unshielded') expect(calls[1].args[4]).toBe(100n);

      const tx = built.unprovenTx as Ledger.UnprovenTransaction;
      expect(tx.intents?.size).toBe(1);
      const intent = [...(tx.intents?.values() ?? [])][0];
      expect(intent.actions).toHaveLength(2);
      const issuerCalls = intent.actions.filter((action) =>
        'communicationCommitment' in action &&
        scaleField(action.communicationCommitment, Ledger.maxField()) === calls[1].args[2],
      );
      expect(issuerCalls).toHaveLength(1);
    },
  );

  it('derives the claim from the actual v2 call and SCALE-decodes it', () => {
    const mintState = state('mint');
    const call = rawCall([]);
    const randomness = Ledger.communicationCommitmentRandomness();
    const prototype = callPrototype(runtime, issuerAddress, 'mint', mintState, call, randomness);
    const actual = callCommitment(runtime, prototype);

    expect(actual).toBe(Ledger.communicationCommitment(input, output, randomness));
    expect(scaleField(actual, Ledger.maxField())).toBeLessThanOrEqual(Ledger.maxField());
  });

  it('rejects malformed SCALE fields before constructing the receiver claim', () => {
    expect(() => scaleField('03', Ledger.maxField())).toThrow('Invalid SCALE field length');
    expect(() => scaleField('', Ledger.maxField())).toThrow('Expected a non-empty');
  });
});
