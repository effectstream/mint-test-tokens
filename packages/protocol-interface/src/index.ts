export type Recipient =
  | {
      kind: "shielded-user";
      shieldedAddress: string;
      coinPublicKey: string;
      encryptionPublicKey: string;
    }
  | { kind: "unshielded-user"; userAddress: string }
  | {
      kind: "contract";
      contractAddress: string;
      receiverCapability: "mint-test-token-receiver-v1" | "mint-test-token-receiver-v2";
    };

export interface MintRequest {
  networkKey: "preview" | "preprod" | "stagenet" | "undeployed";
  contractAddress: string;
  tokenId: string;
  privacy: "shielded" | "unshielded";
  recipient: Recipient;
  amount: bigint;
}

export interface MintSubmission {
  transactionId: string;
  status: "submitted";
  waitForFinalization(): Promise<{
    transactionId: string;
    blockHeight?: bigint;
    blockHash?: string;
  }>;
  /** Present for a shielded mint so callers can verify the encrypted output. */
  shieldedCoinInfo?: { nonce: Uint8Array; color: Uint8Array; value: bigint };
  receiptDelivery: "not-required" | "encrypted-output" | "pending";
}

export interface TokenProtocolAdapter {
  readonly protocolFamily: "midnight-1.x" | "midnight-2.x";
  mint(request: MintRequest): Promise<MintSubmission>;
  readMetadata(contractAddress: string): Promise<{ name: string; symbol: string; decimals: number; tokenId: string }>;
  readBalance(tokenId: string): Promise<bigint>;
}

/** DApp Connector API v4.0.1 methods used by both protocol profiles. */
export interface ConnectedWalletCapabilities {
  getShieldedBalances(): Promise<Record<string, bigint>>;
  getUnshieldedBalances(): Promise<Record<string, bigint>>;
  getShieldedAddresses(): Promise<{
    shieldedAddress: string;
    shieldedCoinPublicKey: string;
    shieldedEncryptionPublicKey: string;
  }>;
  getUnshieldedAddress(): Promise<{ unshieldedAddress: string }>;
  getConfiguration(): Promise<{ networkId: string; indexerUri: string; indexerWsUri: string; substrateNodeUri: string }>;
  getProvingProvider(keyMaterialProvider: unknown): Promise<unknown>;
  balanceUnsealedTransaction(tx: string, options?: { payFees?: boolean }): Promise<{ tx: string }>;
  submitTransaction(tx: string): Promise<void>;
}
