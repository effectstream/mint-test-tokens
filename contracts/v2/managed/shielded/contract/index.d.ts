import type * as __compactRuntime from '@midnight-ntwrk/compact-runtime';

export type Witnesses<PS> = {
}

export type ImpureCircuits<PS> = {
  name(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, string>>;
  symbol(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, string>>;
  decimals(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
  tokenColor(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, Uint8Array>>;
  mint(context: __compactRuntime.CircuitContext<PS>,
       recipient_0: { is_left: boolean,
                      left: { bytes: Uint8Array },
                      right: { bytes: Uint8Array }
                    },
       amount_0: bigint,
       nonce_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, { nonce: Uint8Array,
                                                                           color: Uint8Array,
                                                                           value: bigint
                                                                         }>>;
}

export type ProvableCircuits<PS> = {
  name(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, string>>;
  symbol(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, string>>;
  decimals(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
  tokenColor(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, Uint8Array>>;
  mint(context: __compactRuntime.CircuitContext<PS>,
       recipient_0: { is_left: boolean,
                      left: { bytes: Uint8Array },
                      right: { bytes: Uint8Array }
                    },
       amount_0: bigint,
       nonce_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, { nonce: Uint8Array,
                                                                           color: Uint8Array,
                                                                           value: bigint
                                                                         }>>;
}

export type PureCircuits = {
}

export type Circuits<PS> = {
  name(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, string>>;
  symbol(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, string>>;
  decimals(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
  tokenColor(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, Uint8Array>>;
  mint(context: __compactRuntime.CircuitContext<PS>,
       recipient_0: { is_left: boolean,
                      left: { bytes: Uint8Array },
                      right: { bytes: Uint8Array }
                    },
       amount_0: bigint,
       nonce_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, { nonce: Uint8Array,
                                                                           color: Uint8Array,
                                                                           value: bigint
                                                                         }>>;
}

export type Ledger = {
  readonly _name: string;
  readonly _symbol: string;
  readonly _decimals: bigint;
  readonly _domain: Uint8Array;
}

export type ContractReferenceLocations = any;

export declare const contractReferenceLocations : ContractReferenceLocations;

export declare class Contract<PS = any, W extends Witnesses<PS> = Witnesses<PS>> {
  witnesses: W;
  circuits: Circuits<PS>;
  impureCircuits: ImpureCircuits<PS>;
  provableCircuits: ProvableCircuits<PS>;
  constructor(witnesses: W);
  initialState(context: __compactRuntime.ConstructorContext<PS>,
               name__0: string,
               symbol__0: string,
               decimals__0: bigint,
               domain__0: Uint8Array): Promise<__compactRuntime.ConstructorResult<PS>>;
}

export declare function ledger(state: __compactRuntime.StateValue | __compactRuntime.ChargedState): Ledger;
export declare const pureCircuits: PureCircuits;
export declare const expectedVk: Record<string, string>;
