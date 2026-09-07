// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import * as ledger from "@midnightntwrk/ledger-v9";

const decodeScaleField = (value) => {
  const encoded = Uint8Array.from(Buffer.from(value, "hex"));
  assert.ok(encoded.length > 0, "empty serialized field");
  const mode = encoded[0] & 0b11;
  if (mode === 0b11) {
    const payloadLength = (encoded[0] >> 2) + 4;
    assert.equal(encoded.length, payloadLength + 1, "invalid SCALE field length");
    return BigInt(`0x${Buffer.from(encoded.slice(1)).reverse().toString("hex") || "0"}`);
  }
  const encodedLength = 1 << mode;
  assert.equal(encoded.length, encodedLength, "invalid compact SCALE field length");
  let compact = 0n;
  for (let index = encodedLength - 1; index >= 0; index -= 1) {
    compact = (compact << 8n) | BigInt(encoded[index]);
  }
  return compact >> 2n;
};

const encodeScaleField = (value) => {
  if (value < 1n << 6n) return Uint8Array.of(Number(value << 2n));
  if (value < 1n << 14n) {
    const compact = (value << 2n) | 1n;
    return Uint8Array.of(Number(compact & 0xffn), Number(compact >> 8n));
  }
  if (value < 1n << 30n) {
    const compact = (value << 2n) | 2n;
    return Uint8Array.of(
      Number(compact & 0xffn),
      Number((compact >> 8n) & 0xffn),
      Number((compact >> 16n) & 0xffn),
      Number((compact >> 24n) & 0xffn),
    );
  }
  const payload = [];
  for (let rest = value; rest > 0n; rest >>= 8n) payload.push(Number(rest & 0xffn));
  while (payload.length < 4) payload.push(0);
  return Uint8Array.of(((payload.length - 4) << 2) | 3, ...payload);
};

for (let sample = 0; sample < 1_000; sample += 1) {
  const serialized = ledger.communicationCommitmentRandomness();
  const decoded = decodeScaleField(serialized);
  assert.ok(decoded <= ledger.maxField(), "decoded randomness exceeds field modulus");
  assert.equal(Buffer.from(encodeScaleField(decoded)).toString("hex"), serialized);
}

const input = {
  value: [new Uint8Array()],
  alignment: [{ tag: "atom", value: { tag: "field" } }],
};
const output = {
  value: [new Uint8Array([1, 2])],
  alignment: [{ tag: "atom", value: { tag: "compress" } }],
};
const randomness = ledger.communicationCommitmentRandomness();
const helperCommitment = ledger.communicationCommitment(input, output, randomness);
const prototype = new ledger.ContractCallPrototype(
  "00".repeat(32),
  "mint",
  new ledger.ContractOperation(),
  undefined,
  undefined,
  [],
  input,
  output,
  randomness,
  "mint",
);
const intent = ledger.Intent.new(new Date(Date.now() + 60_000)).addCall(prototype);
assert.equal(intent.actions.length, 1);
const call = intent.actions[0];
assert.ok("communicationCommitment" in call);
assert.equal(
  helperCommitment,
  call.communicationCommitment,
  "pinned ledger-v9 behavior changed: re-evaluate receiver claim construction",
);
const actualCommitment = decodeScaleField(call.communicationCommitment);
assert.ok(actualCommitment <= ledger.maxField());
assert.equal(
  Buffer.from(encodeScaleField(actualCommitment)).toString("hex"),
  call.communicationCommitment,
);

console.log(JSON.stringify({
  profile: "v2",
  scaleRoundTrips: 1_000,
  helperMatchesIntentCall: true,
  actualCommitmentRoundTrips: true,
}));
