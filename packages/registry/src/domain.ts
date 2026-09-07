/** Encode the canonical registry string as UTF-8 and right-pad it with zero bytes to Bytes<32>. */
export function encodeDomainSeparator(value: string): Uint8Array {
  const encoded = new TextEncoder().encode(value);
  if (encoded.length === 0) throw new Error("Domain separator must not be empty");
  if (encoded.length > 32) throw new Error("Domain separator exceeds 32 UTF-8 bytes");
  const result = new Uint8Array(32);
  result.set(encoded);
  return result;
}
