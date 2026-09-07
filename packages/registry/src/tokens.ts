import type { TokenRecord, TokenSymbol } from "./types.js";

export type TokenDefinition = Omit<TokenRecord, "activeDeploymentId" | "deployments">;

export const TOKEN_DEFINITIONS: ReadonlyArray<TokenDefinition> = Object.freeze([
  { symbol: "twBTC", name: "Test-wrapped BTC", decimals: 8, privacy: "shielded", domainSeparator: "mint-test-tokens:twBTC", faucet: { humanAmount: "1", baseUnits: "100000000" } },
  { symbol: "twETH", name: "Test-wrapped ETH", decimals: 18, privacy: "shielded", domainSeparator: "mint-test-tokens:twETH", faucet: { humanAmount: "5", baseUnits: "5000000000000000000" } },
  { symbol: "twUSDC", name: "Test-wrapped USDC", decimals: 6, privacy: "shielded", domainSeparator: "mint-test-tokens:twUSDC", faucet: { humanAmount: "10000", baseUnits: "10000000000" } },
  { symbol: "twUSDM", name: "Test-wrapped USDM", decimals: 6, privacy: "shielded", domainSeparator: "mint-test-tokens:twUSDM", faucet: { humanAmount: "10000", baseUnits: "10000000000" } },
  { symbol: "utwUSDC", name: "Unshielded-test-wrapped USDC", decimals: 6, privacy: "unshielded", domainSeparator: "mint-test-tokens:utwUSDC", faucet: { humanAmount: "10000", baseUnits: "10000000000" } },
  { symbol: "utwBTC", name: "Unshielded-test-wrapped BTC", decimals: 8, privacy: "unshielded", domainSeparator: "mint-test-tokens:utwBTC", faucet: { humanAmount: "1", baseUnits: "100000000" } }
]);

export function tokenDefinition(symbol: TokenSymbol): TokenDefinition {
  const found = TOKEN_DEFINITIONS.find((item) => item.symbol === symbol);
  if (!found) throw new Error(`Unknown token symbol: ${symbol}`);
  return found;
}

export function unavailableTokens(): TokenRecord[] {
  return TOKEN_DEFINITIONS.map((definition) => ({
    ...definition,
    faucet: { ...definition.faucet },
    activeDeploymentId: null,
    deployments: []
  }));
}
