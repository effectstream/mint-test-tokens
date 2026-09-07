export function validateMasterSeedHex(value: string, variableName = "MN_SEED_FILE"): string {
  if (!/^(?:[0-9a-f]{64}|[0-9a-f]{128})$/i.test(value)) {
    throw new Error(`${variableName} must contain exactly 32 or 64 bytes of hexadecimal master seed`);
  }
  return value;
}
