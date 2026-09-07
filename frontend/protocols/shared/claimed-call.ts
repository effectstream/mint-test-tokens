export type ReceiverCircuitId =
  | 'receiveShieldedTokenFromIssuer'
  | 'receiveUnshieldedTokenFromIssuer';

export interface SerializableContractState {
  serialize(): Uint8Array;
}

export interface RawCall {
  public: { partitionedTranscript: readonly [unknown, unknown] };
  private: {
    input: unknown;
    output: unknown;
    privateTranscriptOutputs: unknown[];
    result: unknown;
    unprovenTx: {
      guaranteedOffer?: unknown;
      fallibleOffer?: { values(): IterableIterator<unknown> };
    };
  };
}

interface CallPrototype {}

interface ContractCall {
  communicationCommitment: string;
}

interface Intent {
  readonly actions: unknown[];
  addCall(call: CallPrototype): Intent;
}

export interface ClaimedCallLedger {
  ContractState: {
    deserialize(value: Uint8Array): { operation(circuitId: string): unknown };
  };
  ContractCallPrototype: new (
    address: string,
    circuitId: string,
    operation: unknown,
    guaranteedTranscript: unknown,
    fallibleTranscript: unknown,
    privateTranscriptOutputs: unknown[],
    input: unknown,
    output: unknown,
    communicationRandomness: string,
    keyLocation: string,
  ) => CallPrototype;
  Intent: { new: (ttl: Date) => Intent };
  Transaction: {
    fromPartsRandomized(
      networkId: string,
      guaranteedOffer: unknown,
      fallibleOffer: unknown,
      intent: Intent,
    ): unknown;
  };
  communicationCommitmentRandomness(): string;
  maxField(): bigint;
}

export interface CallOptions {
  compiledContract: unknown;
  contractAddress: string;
  circuitId: string;
  args: unknown[];
}

export type CreateUnprovenCall = (
  providers: Record<string, unknown>,
  options: CallOptions,
) => Promise<RawCall>;

export interface ClaimedContractMintOptions {
  ledger: ClaimedCallLedger;
  networkId: string;
  privacy: 'shielded' | 'unshielded';
  amount: bigint;
  issuerAddress: string;
  receiverAddress: string;
  compiledIssuer: unknown;
  compiledReceiver: unknown;
  providers: Record<string, unknown>;
  publicDataProvider: unknown;
  createUnprovenCall: CreateUnprovenCall;
  readContractState(publicDataProvider: unknown, address: string): Promise<SerializableContractState>;
  encodeContractAddress(address: string): Uint8Array;
  entryPointHash(circuitId: string): string;
  nonce?: Uint8Array;
}

export interface ClaimedContractMint {
  unprovenTx: unknown;
  circuitIds: readonly ['mint', ReceiverCircuitId];
}

function fail(message: string): never {
  throw new Error(message);
}

export function hexBytes(value: string): Uint8Array {
  const hex = value.replace(/^0x/i, '');
  if (!hex || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
    fail('Expected a non-empty, even-length hexadecimal value.');
  }
  return Uint8Array.from(hex.match(/.{2}/g) ?? [], (part) => Number.parseInt(part, 16));
}

/** Decodes the SCALE compact integer used to serialize a ledger Field. */
export function scaleField(value: string, maxField: bigint): bigint {
  const encoded = hexBytes(value);
  const mode = encoded[0] & 0b11;
  let decoded: bigint;
  if (mode === 0b11) {
    const payloadLength = (encoded[0] >> 2) + 4;
    if (encoded.length !== payloadLength + 1) fail('Invalid SCALE field length.');
    const payload = encoded.slice(1);
    decoded = 0n;
    for (let index = payload.length - 1; index >= 0; index -= 1) {
      decoded = (decoded << 8n) | BigInt(payload[index]);
    }
  } else {
    const encodedLength = 1 << mode;
    if (encoded.length !== encodedLength) fail('Invalid compact SCALE field length.');
    let compact = 0n;
    for (let index = encodedLength - 1; index >= 0; index -= 1) {
      compact = (compact << 8n) | BigInt(encoded[index]);
    }
    decoded = compact >> 2n;
  }
  if (decoded > maxField) fail('Decoded field exceeds the scalar modulus.');
  return decoded;
}

export function callPrototype(
  ledger: ClaimedCallLedger,
  address: string,
  circuitId: string,
  state: SerializableContractState,
  call: RawCall,
  communicationRandomness: string,
): CallPrototype {
  const operation = ledger.ContractState.deserialize(state.serialize()).operation(circuitId);
  if (!operation) fail(`Missing ${circuitId} operation at ${address}.`);
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
}

/** Uses the commitment of the actual Intent call. Ledger v8's standalone helper differs. */
export function callCommitment(ledger: ClaimedCallLedger, prototype: CallPrototype): string {
  const probe = ledger.Intent.new(new Date(Date.now() + 60 * 60 * 1_000)).addCall(prototype);
  if (probe.actions.length !== 1) fail('Issuer commitment probe must contain one call.');
  const call = probe.actions[0];
  if (!call || typeof call !== 'object' || !('communicationCommitment' in call)) {
    fail('Issuer action must be a contract call.');
  }
  return (call as ContractCall).communicationCommitment;
}

export function composeClaimedIssuerCall(
  ledger: ClaimedCallLedger,
  networkId: string,
  issuerPrototype: CallPrototype,
  issuerCommitment: string,
  receiverAddress: string,
  receiverState: SerializableContractState,
  receiverCircuitId: ReceiverCircuitId,
  receiverCall: RawCall,
): unknown {
  const receiverTx = receiverCall.private.unprovenTx;
  const fallibleOffers = [...(receiverTx.fallibleOffer?.values() ?? [])];
  if (fallibleOffers.length > 1) fail('A single receiver call may have at most one fallible offer.');
  const intent = ledger.Intent.new(new Date(Date.now() + 60 * 60 * 1_000))
    .addCall(issuerPrototype)
    .addCall(callPrototype(
      ledger,
      receiverAddress,
      receiverCircuitId,
      receiverState,
      receiverCall,
      ledger.communicationCommitmentRandomness(),
    ));
  const issuerCalls = intent.actions.filter((action) =>
    action !== null &&
    typeof action === 'object' &&
    'communicationCommitment' in action &&
    action.communicationCommitment === issuerCommitment,
  );
  if (issuerCalls.length !== 1) {
    fail('Final intent must contain exactly one issuer call with the claimed commitment.');
  }
  return ledger.Transaction.fromPartsRandomized(
    networkId,
    receiverTx.guaranteedOffer,
    fallibleOffers[0],
    intent,
  );
}

export async function buildClaimedContractMint(
  options: ClaimedContractMintOptions,
): Promise<ClaimedContractMint> {
  const {
    ledger,
    privacy,
    amount,
    issuerAddress,
    receiverAddress,
    providers,
  } = options;
  const [issuerState, receiverState] = await Promise.all([
    options.readContractState(options.publicDataProvider, issuerAddress),
    options.readContractState(options.publicDataProvider, receiverAddress),
  ]);
  const receiverAddressBytes = options.encodeContractAddress(receiverAddress);
  const blank = new Uint8Array(32);
  const issuerRecipient = privacy === 'shielded'
    ? { is_left: false, left: { bytes: blank }, right: { bytes: receiverAddressBytes } }
    : { is_left: true, left: { bytes: receiverAddressBytes }, right: { bytes: blank } };
  if (privacy === 'shielded' && !options.nonce) fail('A shielded contract mint requires a nonce.');
  const issuerArgs = privacy === 'shielded'
    ? [issuerRecipient, amount, options.nonce]
    : [issuerRecipient, amount];
  const issuerCall = await options.createUnprovenCall(providers, {
    compiledContract: options.compiledIssuer,
    contractAddress: issuerAddress,
    circuitId: 'mint',
    args: issuerArgs,
  });
  const issuerPrototype = callPrototype(
    ledger,
    issuerAddress,
    'mint',
    issuerState,
    issuerCall,
    ledger.communicationCommitmentRandomness(),
  );
  const issuerCommitment = callCommitment(ledger, issuerPrototype);
  const receiverCircuitId: ReceiverCircuitId = privacy === 'shielded'
    ? 'receiveShieldedTokenFromIssuer'
    : 'receiveUnshieldedTokenFromIssuer';
  const receiverArgs = [
    options.encodeContractAddress(issuerAddress),
    hexBytes(options.entryPointHash('mint')),
    scaleField(issuerCommitment, ledger.maxField()),
    issuerCall.private.result,
    ...(privacy === 'unshielded' ? [amount] : []),
  ];
  const receiverCall = await options.createUnprovenCall(providers, {
    compiledContract: options.compiledReceiver,
    contractAddress: receiverAddress,
    circuitId: receiverCircuitId,
    args: receiverArgs,
  });
  return {
    unprovenTx: composeClaimedIssuerCall(
      ledger,
      options.networkId,
      issuerPrototype,
      issuerCommitment,
      receiverAddress,
      receiverState,
      receiverCircuitId,
      receiverCall,
    ),
    circuitIds: ['mint', receiverCircuitId],
  };
}
