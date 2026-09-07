import {
  mainnet,
  MidnightBech32m,
  ShieldedAddress,
  ShieldedCoinPublicKey,
  ShieldedEncryptionPublicKey,
} from '@midnightntwrk/wallet-sdk-address-format';
import { bech32m } from '@scure/base';
import { Buffer } from 'buffer';

export interface ShieldedIdentityInput {
  shieldedAddress: string;
  coinPublicKey: string;
  encryptionPublicKey: string;
}

export interface ResolvedShieldedAddress {
  coinKey: string;
  encryptionKey: string;
}

function rawHex(value: string): string | null {
  const normalized = value.trim().replace(/^0x/i, '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(normalized) ? normalized : null;
}

function parseBech32m(value: string): MidnightBech32m {
  const decoded = bech32m.decodeToBytes(value.trim(), false);
  const segments = decoded.prefix.split('_');
  if (segments.length < 2 || segments.length > 3 || segments[0] !== MidnightBech32m.prefix) {
    throw new Error('Invalid Midnight Bech32m prefix.');
  }
  return new MidnightBech32m(
    segments[1],
    segments[2] ?? mainnet,
    Buffer.from(decoded.bytes),
  );
}

function requireKeyHex(value: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error('Shielded public keys must contain exactly 32 bytes.');
  }
  return value;
}

function coinKey(value: string, networkId: string): string {
  const hex = rawHex(value);
  return requireKeyHex(hex
    ? ShieldedCoinPublicKey.fromHexString(hex).toHexString()
    : ShieldedCoinPublicKey.codec.decode(networkId, parseBech32m(value)).toHexString());
}

function encryptionKey(value: string, networkId: string): string {
  const hex = rawHex(value);
  return requireKeyHex(hex
    ? ShieldedEncryptionPublicKey.fromHexString(hex).toHexString()
    : ShieldedEncryptionPublicKey.codec.decode(networkId, parseBech32m(value)).toHexString());
}

export function normalizeShieldedIdentity(value: ShieldedIdentityInput, networkId: string) {
  const resolved = resolveShieldedAddress(value.shieldedAddress, networkId);
  const normalizedCoinKey = coinKey(value.coinPublicKey, networkId);
  const normalizedEncryptionKey = encryptionKey(value.encryptionPublicKey, networkId);
  if (resolved.coinKey !== normalizedCoinKey.toLowerCase()) {
    throw new Error('Shielded address and coin public key do not match.');
  }
  if (resolved.encryptionKey !== normalizedEncryptionKey.toLowerCase()) {
    throw new Error('Shielded address and encryption public key do not match.');
  }
  return { coinKey: normalizedCoinKey, encryptionKey: normalizedEncryptionKey };
}

export function resolveShieldedAddress(shieldedAddress: string, networkId: string): ResolvedShieldedAddress {
  const address = parseBech32m(shieldedAddress).decode(ShieldedAddress, networkId);
  return {
    coinKey: requireKeyHex(address.coinPublicKeyString().toLowerCase()),
    encryptionKey: requireKeyHex(address.encryptionPublicKeyString().toLowerCase()),
  };
}
