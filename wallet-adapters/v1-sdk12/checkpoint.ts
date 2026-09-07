import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

const SHA256 = /^[0-9a-f]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const PROFILE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const MAX_CHECKPOINT_BYTES = 128 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024;
const MAX_SNAPSHOT_BYTES = 96 * 1024 * 1024;
const MAX_SNAPSHOTS_BYTES = 120 * 1024 * 1024;
const MAX_WITNESS_BYTES = 16 * 1024 * 1024;

export const SDK12_CHECKPOINT_COHORT = Object.freeze({
  abstractions: "2.1.0",
  application: "0.0.0-private",
  capabilities: "3.3.1",
  dust: "4.2.0",
  facade: "4.1.0",
  ledgerV8: "8.1.0",
  lockfileSha256: "9335add1999c89b27577405252522fd6bb206dd71681266dd7f1d9738aac99ef",
  shielded: "3.0.2",
  unshielded: "3.1.0",
  walletSdk: "1.2.0"
});

type EventWitness = {
  eventDigest: string;
  kind: "event";
  protocol: string;
  requestedId: string;
  returnedId: string;
  stream: "dustLedgerEvents" | "zswapLedgerEvents";
};
type OriginWitness = { kind: "origin"; requestedId: "0" };
type UnshieldedEventWitness = {
  blockHash: string;
  eventDigest: string;
  kind: "event";
  requestedAppliedId: string;
  returnedId: string;
  stream: "unshieldedTransactions";
  transactionHash: string;
};
type UnshieldedOriginWitness = { kind: "origin"; requestedAppliedId: "0" };

export interface WalletCliCheckpoint {
  chainFingerprint: string;
  cursorWitnesses: {
    dust: EventWitness | OriginWitness;
    shielded: EventWitness | OriginWitness;
    unshielded: UnshieldedEventWitness | UnshieldedOriginWitness;
  };
  derivation: { account: 0; index: 0 };
  envelopeVersion: 2;
  generation: string;
  identityBinding: string;
  integrity: { algorithm: "sha256"; payloadDigest: string };
  kind: "midnight-balance-checkpoint";
  networkId: "preprod";
  profile: string;
  savedAt: string;
  versions: typeof SDK12_CHECKPOINT_COHORT;
  wallets: { dust: string; shielded: string; unshielded: string };
}

interface WalletCliManifest {
  createdAt: string;
  derivation: { account: 0; index: 0 };
  identityBinding: string;
  integrity: { algorithm: "sha256"; payloadDigest: string };
  kind: "wallet-cli-profile";
  manifestVersion: 2;
  profile: string;
}

export interface ValidatedCheckpointFiles {
  checkpoint: WalletCliCheckpoint;
  profileLockPath: string;
}

const record = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
};
const exact = (value: unknown, keys: readonly string[], label: string): Record<string, unknown> => {
  const output = record(value, label);
  if (Object.keys(output).sort().join("\0") !== [...keys].sort().join("\0")) throw new Error(`${label} has unexpected fields`);
  return output;
};
const sha256 = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value) && Object.keys(value).length === value.length) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  throw new Error("value is not canonical JSON");
}

const assertIntegrity = (value: Record<string, unknown>, label: string): void => {
  const integrity = exact(value.integrity, ["algorithm", "payloadDigest"], `${label}.integrity`);
  if (integrity.algorithm !== "sha256" || typeof integrity.payloadDigest !== "string" || !SHA256.test(integrity.payloadDigest)) {
    throw new Error(`${label} has invalid integrity metadata`);
  }
  const payload = { ...value };
  delete payload.integrity;
  if (sha256(canonicalJson(payload)) !== integrity.payloadDigest) throw new Error(`${label} integrity mismatch`);
};
const assertDate = (value: unknown, label: string): void => {
  if (typeof value !== "string" || new Date(value).toISOString() !== value) throw new Error(`${label} must be a canonical timestamp`);
};
const assertDerivation = (value: unknown, label: string): void => {
  const derivation = exact(value, ["account", "index"], label);
  if (derivation.account !== 0 || derivation.index !== 0) throw new Error(`${label} must be account 0/index 0`);
};
const assertProfile: (value: unknown) => asserts value is string = (value) => {
  if (typeof value !== "string" || !PROFILE.test(value) || ["checkpoint", "preprod", "preview", "profile", "profiles", "session"].includes(value)) {
    throw new Error("invalid checkpoint profile");
  }
};
const assertDecimal: (value: unknown, label: string) => asserts value is string = (value, label) => {
  if (typeof value !== "string" || !DECIMAL.test(value)) throw new Error(`${label} must be an unsigned decimal`);
};
const assertCursorDecimal: (value: unknown, label: string) => asserts value is string = (value, label) => {
  assertDecimal(value, label);
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric > 2_147_483_647) throw new Error(`${label} exceeds the GraphQL cursor bound`);
};
const assertSafeText: (value: unknown, label: string) => asserts value is string = (value, label) => {
  if (typeof value !== "string" || !/^[\x21-\x7e]{1,512}$/.test(value)) throw new Error(`${label} must be safe text`);
};

const validateStreamWitness = (value: unknown, stream: "dustLedgerEvents" | "zswapLedgerEvents"): EventWitness | OriginWitness => {
  const object = record(value, stream);
  if (object.kind === "origin") {
    const origin = exact(object, ["kind", "requestedId"], stream);
    if (origin.requestedId !== "0") throw new Error(`${stream} origin cursor is invalid`);
    return origin as unknown as OriginWitness;
  }
  const event = exact(object, ["eventDigest", "kind", "protocol", "requestedId", "returnedId", "stream"], stream);
  if (event.kind !== "event" || event.stream !== stream || typeof event.eventDigest !== "string" || !SHA256.test(event.eventDigest)) {
    throw new Error(`${stream} witness is invalid`);
  }
  assertCursorDecimal(event.requestedId, `${stream}.requestedId`);
  assertCursorDecimal(event.returnedId, `${stream}.returnedId`);
  if (BigInt(event.returnedId) < BigInt(event.requestedId)) throw new Error(`${stream} returned cursor precedes its request`);
  assertSafeText(event.protocol, `${stream}.protocol`);
  return event as unknown as EventWitness;
};

const validateUnshieldedWitness = (value: unknown): UnshieldedEventWitness | UnshieldedOriginWitness => {
  const object = record(value, "unshieldedTransactions");
  if (object.kind === "origin") {
    const origin = exact(object, ["kind", "requestedAppliedId"], "unshieldedTransactions");
    if (origin.requestedAppliedId !== "0") throw new Error("unshielded origin cursor is invalid");
    return origin as unknown as UnshieldedOriginWitness;
  }
  const event = exact(object, ["blockHash", "eventDigest", "kind", "requestedAppliedId", "returnedId", "stream", "transactionHash"], "unshieldedTransactions");
  if (event.kind !== "event" || event.stream !== "unshieldedTransactions" || typeof event.eventDigest !== "string" || !SHA256.test(event.eventDigest)) {
    throw new Error("unshielded witness is invalid");
  }
  assertCursorDecimal(event.requestedAppliedId, "unshielded.requestedAppliedId");
  assertCursorDecimal(event.returnedId, "unshielded.returnedId");
  if (BigInt(event.returnedId) < BigInt(event.requestedAppliedId)) throw new Error("unshielded returned cursor precedes its request");
  assertSafeText(event.blockHash, "unshielded.blockHash");
  assertSafeText(event.transactionHash, "unshielded.transactionHash");
  return event as unknown as UnshieldedEventWitness;
};

export function validateCheckpointValue(value: unknown): WalletCliCheckpoint {
  const object = exact(value, ["chainFingerprint", "cursorWitnesses", "derivation", "envelopeVersion", "generation", "identityBinding", "integrity", "kind", "networkId", "profile", "savedAt", "versions", "wallets"], "checkpoint");
  assertIntegrity(object, "checkpoint");
  if (object.kind !== "midnight-balance-checkpoint" || object.envelopeVersion !== 2 || object.networkId !== "preprod") throw new Error("unsupported checkpoint kind, version, or network");
  if (typeof object.chainFingerprint !== "string" || !SHA256.test(object.chainFingerprint) || typeof object.identityBinding !== "string" || !SHA256.test(object.identityBinding)) throw new Error("checkpoint identity is invalid");
  assertProfile(object.profile);
  assertDate(object.savedAt, "checkpoint.savedAt");
  assertDecimal(object.generation, "checkpoint.generation");
  if (object.generation === "0") throw new Error("checkpoint generation must be positive");
  assertDerivation(object.derivation, "checkpoint.derivation");
  const versions = exact(object.versions, Object.keys(SDK12_CHECKPOINT_COHORT), "checkpoint.versions");
  for (const [key, expected] of Object.entries(SDK12_CHECKPOINT_COHORT)) if (versions[key] !== expected) throw new Error(`checkpoint SDK cohort mismatch at ${key}`);
  const cursors = exact(object.cursorWitnesses, ["dust", "shielded", "unshielded"], "checkpoint.cursorWitnesses");
  const wallets = exact(object.wallets, ["dust", "shielded", "unshielded"], "checkpoint.wallets");
  let combined = 0;
  for (const role of ["dust", "shielded", "unshielded"] as const) {
    if (typeof wallets[role] !== "string") throw new Error(`${role} snapshot must be text`);
    const bytes = Buffer.byteLength(wallets[role] as string);
    if (bytes < 1 || bytes > MAX_SNAPSHOT_BYTES) throw new Error(`${role} snapshot exceeds its bound`);
    combined += bytes;
  }
  if (combined > MAX_SNAPSHOTS_BYTES) throw new Error("combined wallet snapshots exceed their bound");
  return Object.freeze({
    ...object,
    cursorWitnesses: {
      dust: validateStreamWitness(cursors.dust, "dustLedgerEvents"),
      shielded: validateStreamWitness(cursors.shielded, "zswapLedgerEvents"),
      unshielded: validateUnshieldedWitness(cursors.unshielded)
    },
    wallets
  }) as unknown as WalletCliCheckpoint;
}

const validateManifestValue = (value: unknown): WalletCliManifest => {
  const object = exact(value, ["createdAt", "derivation", "identityBinding", "integrity", "kind", "manifestVersion", "profile"], "profile manifest");
  assertIntegrity(object, "profile manifest");
  if (object.kind !== "wallet-cli-profile" || object.manifestVersion !== 2 || typeof object.identityBinding !== "string" || !SHA256.test(object.identityBinding)) throw new Error("profile manifest is invalid");
  assertProfile(object.profile);
  assertDate(object.createdAt, "profile.createdAt");
  assertDerivation(object.derivation, "profile.derivation");
  return object as unknown as WalletCliManifest;
};

const assertOwnerOnly = async (path: string, maximum: number): Promise<Buffer> => {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0 || metadata.size < 1 || metadata.size > maximum) throw new Error(`${path} is not a bounded owner-only regular file`);
  return readFile(path);
};

export async function validateCheckpointFiles(input: {
  checkpointPath: string;
  expectedIdentityBinding: string;
}): Promise<ValidatedCheckpointFiles> {
  const checkpointPath = resolve(input.checkpointPath);
  if (basename(checkpointPath) !== "checkpoint.json" || basename(dirname(checkpointPath)) !== "preprod") throw new Error("checkpoint path must end in preprod/checkpoint.json");
  const profileDirectory = dirname(dirname(checkpointPath));
  const profile = basename(profileDirectory);
  assertProfile(profile);
  const [checkpointBytes, manifestBytes] = await Promise.all([
    assertOwnerOnly(checkpointPath, MAX_CHECKPOINT_BYTES),
    assertOwnerOnly(resolve(profileDirectory, "profile.json"), MAX_MANIFEST_BYTES)
  ]);
  const checkpoint = validateCheckpointValue(parseStrictJson(checkpointBytes.toString("utf8")));
  const manifest = validateManifestValue(parseStrictJson(manifestBytes.toString("utf8")));
  if (checkpoint.profile !== profile || manifest.profile !== profile || checkpoint.identityBinding !== input.expectedIdentityBinding || manifest.identityBinding !== input.expectedIdentityBinding || checkpoint.identityBinding !== manifest.identityBinding) {
    throw new Error("checkpoint profile or identity binding mismatch");
  }
  return { checkpoint, profileLockPath: resolve(profileDirectory, "session.lock") };
}

export function checkpointProfileLockPath(checkpointPath: string): string {
  const absolute = resolve(checkpointPath);
  if (basename(absolute) !== "checkpoint.json" || basename(dirname(absolute)) !== "preprod") throw new Error("checkpoint path must end in preprod/checkpoint.json");
  const profileDirectory = dirname(dirname(absolute));
  assertProfile(basename(profileDirectory));
  return resolve(profileDirectory, "session.lock");
}

export const chainFingerprint = (genesisHash: string): string => {
  if (!/^0x[0-9a-f]{64}$/.test(genesisHash)) throw new Error("invalid canonical genesis hash");
  return sha256(`wallet-cli:chain-fingerprint:v2\0preprod\0${genesisHash}`);
};

interface StreamEventResult { id: string; maxId: string; protocolVersion: string; raw: string }
interface UnshieldedEventResult { __typename: "UnshieldedTransaction"; transaction: { id: number; hash: string; raw: string; protocolVersion: number; block: { hash: string } }; createdUtxos: unknown[]; spentUtxos: unknown[] }

const socketMessage = (event: MessageEvent): Record<string, unknown> => record(JSON.parse(String(event.data)), "WebSocket message");
const websocketQuery = async <T>(endpoint: string, query: string, variables: object, select: (value: unknown) => T | undefined, timeoutMs: number): Promise<T> => new Promise((resolveQuery, rejectQuery) => {
  const socket = new WebSocket(endpoint, "graphql-transport-ws");
  let done = false;
  let bytes = 0;
  const finish = (error?: unknown, value?: T) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    socket.close(1000, "checkpoint-witness-complete");
    if (error !== undefined || value === undefined) rejectQuery(error instanceof Error ? error : new Error("checkpoint witness query failed"));
    else resolveQuery(value);
  };
  const timer = setTimeout(() => finish(new Error("checkpoint witness query timed out")), timeoutMs);
  socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "connection_init" })));
  socket.addEventListener("message", (event) => {
    try {
      bytes += Buffer.byteLength(String(event.data));
      if (bytes > MAX_WITNESS_BYTES) throw new Error("checkpoint witness response exceeded its bound");
      const message = socketMessage(event);
      if (message.type === "connection_ack") {
        socket.send(JSON.stringify({ id: "checkpoint-witness", type: "subscribe", payload: { query, variables } }));
      } else if (message.type === "next" && message.id === "checkpoint-witness") {
        const selected = select(message.payload);
        if (selected !== undefined) finish(undefined, selected);
      } else if (message.type === "error") finish(new Error("checkpoint witness query rejected"));
    } catch (error) { finish(error); }
  });
  socket.addEventListener("error", () => finish(new Error("checkpoint witness socket failed")));
  socket.addEventListener("close", () => { if (!done) finish(new Error("checkpoint witness socket closed")); });
});

const dataField = (payload: unknown, field: string): unknown => record(record(payload, "GraphQL payload").data, "GraphQL data")[field];
const rawBytes = (value: unknown): Buffer => {
  if (typeof value !== "string") throw new Error("witness raw event is not text");
  const hex = value.replace(/^0x/, "");
  if (!hex.length || hex.length % 2 || !/^[0-9a-f]+$/i.test(hex)) throw new Error("witness raw event is not hex");
  return Buffer.from(hex, "hex");
};

export function assertStreamWitnessResult(
  witness: EventWitness | OriginWitness,
  row: StreamEventResult,
  field: "dustLedgerEvents" | "zswapLedgerEvents"
): void {
  if (witness.kind === "origin") throw new Error(`${field} origin checkpoint cannot fund deployment`);
  if (String(row.id) !== witness.returnedId || String(row.protocolVersion) !== witness.protocol || sha256(rawBytes(row.raw)) !== witness.eventDigest) {
    throw new Error(`${field} cursor witness mismatch`);
  }
}

export function assertUnshieldedWitnessResult(
  witness: UnshieldedEventWitness | UnshieldedOriginWitness,
  row: UnshieldedEventResult
): void {
  if (witness.kind === "origin") throw new Error("unshielded origin checkpoint cannot fund deployment");
  const canonical = canonicalJson(row);
  if (String(row.transaction.id) !== witness.returnedId || row.transaction.hash !== witness.transactionHash || row.transaction.block.hash !== witness.blockHash || sha256(Buffer.from(canonical)) !== witness.eventDigest) {
    throw new Error("unshielded cursor witness mismatch");
  }
}

export async function validateCheckpointChain(input: {
  checkpoint: WalletCliCheckpoint;
  genesisHash: string;
  indexerWs: string;
  timeoutMs: number;
  unshieldedAddress: string;
}): Promise<void> {
  if (chainFingerprint(input.genesisHash) !== input.checkpoint.chainFingerprint) throw new Error("checkpoint genesis fingerprint mismatch");
  for (const [role, field] of [["shielded", "zswapLedgerEvents"], ["dust", "dustLedgerEvents"]] as const) {
    const witness = input.checkpoint.cursorWitnesses[role];
    if (witness.kind === "origin") throw new Error(`${field} origin checkpoint cannot fund deployment`);
    const row = await websocketQuery<StreamEventResult>(input.indexerWs, `subscription CheckpointWitness($id: Int) { ${field}(id: $id) { id raw protocolVersion maxId } }`, { id: Number(witness.requestedId) }, (payload) => dataField(payload, field) as StreamEventResult, input.timeoutMs);
    assertStreamWitnessResult(witness, row, field);
  }
  const witness = input.checkpoint.cursorWitnesses.unshielded;
  if (witness.kind === "origin") throw new Error("unshielded origin checkpoint cannot fund deployment");
  const row = await websocketQuery<UnshieldedEventResult>(input.indexerWs, `subscription CheckpointUnshieldedWitness($address: UnshieldedAddress!, $transactionId: Int) {
    unshieldedTransactions(address: $address, transactionId: $transactionId) {
      __typename
      ... on UnshieldedTransaction {
        transaction { __typename id hash raw protocolVersion block { hash } }
        createdUtxos { owner tokenType value outputIndex intentHash initialNonce ctime registeredForDustGeneration }
        spentUtxos { owner tokenType value outputIndex intentHash initialNonce ctime registeredForDustGeneration }
      }
      ... on UnshieldedTransactionsProgress { highestTransactionId }
    }
  }`, { address: input.unshieldedAddress, transactionId: Number(witness.requestedAppliedId) }, (payload) => {
    const value = dataField(payload, "unshieldedTransactions") as UnshieldedEventResult | { __typename?: string };
    return value?.__typename === "UnshieldedTransaction" ? value as UnshieldedEventResult : undefined;
  }, input.timeoutMs);
  assertUnshieldedWitnessResult(witness, row);
}

export function parseStrictJson(text: string): unknown {
  return new StrictJsonParser(text).parse();
}

class StrictJsonParser {
  #index = 0;
  constructor(readonly text: string) {}
  parse(): unknown { this.space(); const value = this.value(); this.space(); if (this.#index !== this.text.length) throw new Error("invalid JSON"); return value; }
  value(): unknown {
    const char = this.text[this.#index];
    if (char === "{") return this.object();
    if (char === "[") return this.array();
    if (char === '"') return this.string();
    for (const [literal, value] of [["true", true], ["false", false], ["null", null]] as const) if (this.text.startsWith(literal, this.#index)) { this.#index += literal.length; return value; }
    return this.number();
  }
  object(): Record<string, unknown> {
    this.#index++; const result: Record<string, unknown> = {}; const keys = new Set<string>(); this.space();
    if (this.text[this.#index] === "}") { this.#index++; return result; }
    for (;;) {
      if (this.text[this.#index] !== '"') throw new Error("invalid JSON object");
      const key = this.string(); if (keys.has(key)) throw new Error("duplicate JSON key"); keys.add(key); this.space();
      if (this.text[this.#index++] !== ":") throw new Error("invalid JSON object"); this.space(); result[key] = this.value(); this.space();
      const next = this.text[this.#index++]; if (next === "}") return result; if (next !== ",") throw new Error("invalid JSON object"); this.space();
    }
  }
  array(): unknown[] {
    this.#index++; const result: unknown[] = []; this.space(); if (this.text[this.#index] === "]") { this.#index++; return result; }
    for (;;) { result.push(this.value()); this.space(); const next = this.text[this.#index++]; if (next === "]") return result; if (next !== ",") throw new Error("invalid JSON array"); this.space(); }
  }
  string(): string {
    const start = this.#index++; let escaped = false;
    while (this.#index < this.text.length) { const char = this.text[this.#index++]; if (!escaped && char === '"') return JSON.parse(this.text.slice(start, this.#index)) as string; if (!escaped && char === "\\") escaped = true; else escaped = false; if (char !== undefined && char < " " && !escaped) throw new Error("invalid JSON string"); }
    throw new Error("unterminated JSON string");
  }
  number(): number {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(this.text.slice(this.#index));
    if (!match) throw new Error("invalid JSON number"); this.#index += match[0].length; const value = Number(match[0]); if (!Number.isSafeInteger(value)) throw new Error("JSON number is not a safe integer"); return value;
  }
  space(): void { while (/[ \t\r\n]/.test(this.text[this.#index] ?? "")) this.#index++; }
}
