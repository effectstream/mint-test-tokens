import type { NetworkKey } from "../../packages/registry/src/types.js";

export interface EndpointConfig {
  key: NetworkKey;
  displayName: string;
  networkId: string;
  indexer: string;
  indexerWS: string;
  node: string;
  nodeWS: string;
  proofServer: string;
}

const replaceProtocol = (url: string, secure: string, plain: string): string =>
  url.replace(/^https:/, secure).replace(/^http:/, plain);

const defaults: Record<"preview" | "preprod" | "stagenet", Omit<EndpointConfig, "proofServer">> = {
  preview: {
    key: "preview",
    displayName: "Preview",
    networkId: "preview",
    indexer: "https://indexer.preview.midnight.network/api/v4/graphql",
    indexerWS: "wss://indexer.preview.midnight.network/api/v4/graphql/ws",
    node: "https://rpc.preview.midnight.network",
    nodeWS: "wss://rpc.preview.midnight.network"
  },
  preprod: {
    key: "preprod",
    displayName: "Preprod",
    networkId: "preprod",
    indexer: "https://indexer.preprod.midnight.network/api/v4/graphql",
    indexerWS: "wss://indexer.preprod.midnight.network/api/v4/graphql/ws",
    node: "https://rpc.preprod.midnight.network",
    nodeWS: "wss://rpc.preprod.midnight.network"
  },
  stagenet: {
    key: "stagenet",
    displayName: "Stagenet",
    networkId: "stagenet",
    indexer: "https://indexer.stagenet.shielded.tools/api/v4/graphql",
    indexerWS: "wss://indexer.stagenet.shielded.tools/api/v4/graphql/ws",
    node: "https://rpc.stagenet.shielded.tools",
    nodeWS: "wss://rpc.stagenet.shielded.tools"
  }
};

export function endpointConfig(key: NetworkKey): EndpointConfig {
  if (key === "undeployed") {
    const node = process.env.MN_NODE_URL?.trim() || "http://127.0.0.1:9944";
    const indexer = process.env.MN_INDEXER_URL?.trim() || "http://127.0.0.1:8088/api/v4/graphql";
    return {
      key,
      displayName: "Local undeployed",
      networkId: "undeployed",
      node,
      nodeWS: process.env.MN_NODE_WS_URL?.trim() || replaceProtocol(node, "wss:", "ws:"),
      indexer,
      indexerWS: process.env.MN_INDEXER_WS_URL?.trim() || replaceProtocol(indexer, "wss:", "ws:").replace(/\/graphql$/, "/graphql/ws"),
      proofServer: process.env.MN_PROOF_SERVER_URL?.trim() || "http://127.0.0.1:6300"
    };
  }
  const base = defaults[key];
  return {
    ...base,
    proofServer: process.env.MN_PROOF_SERVER_URL?.trim() || "http://127.0.0.1:6300"
  };
}

export async function rpc<T>(nodeUrl: string, method: string, params: unknown[] = []): Promise<T> {
  const response = await fetch(nodeUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  if (!response.ok) throw new Error(`${method} HTTP ${response.status}`);
  const body = await response.json() as { result?: T; error?: { message?: string } };
  if (body.error || body.result === undefined) throw new Error(`${method}: ${body.error?.message ?? "missing result"}`);
  return body.result;
}
