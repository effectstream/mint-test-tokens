import { describe, expect, it } from 'vitest';
import { normalizeShieldedIdentity } from './identity';

const connectorFixture = {
  shieldedAddress: 'mn_shield-addr_preview1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygjyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygsmyslu0',
  coinPublicKey: 'mn_shield-cpk_preview1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygs2j74k6',
  encryptionPublicKey: 'mn_shield-epk_preview1yg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3qrp3fnf',
  coinHex: '11'.repeat(32),
  encryptionHex: '22'.repeat(32),
};

const mismatchedCoinKey = 'mn_shield-cpk_preview1xvenxvenxvenxvenxvenxvenxvenxvenxvenxvenxvenxvenxvesznvd9c';

describe('v1 connector shielded identity', () => {
  it('decodes API 4 Bech32m address and keys to raw ledger hex', () => {
    expect(normalizeShieldedIdentity(connectorFixture, 'preview')).toEqual({
      coinKey: connectorFixture.coinHex,
      encryptionKey: connectorFixture.encryptionHex,
    });
    expect(normalizeShieldedIdentity({
      ...connectorFixture,
      coinPublicKey: `0x${connectorFixture.coinHex}`,
      encryptionPublicKey: connectorFixture.encryptionHex,
    }, 'preview')).toEqual({
      coinKey: connectorFixture.coinHex,
      encryptionKey: connectorFixture.encryptionHex,
    });
  });

  it('rejects wrong-network, wrong-type, and mismatched keys', () => {
    expect(() => normalizeShieldedIdentity(connectorFixture, 'preprod')).toThrow();
    expect(() => normalizeShieldedIdentity({
      ...connectorFixture,
      coinPublicKey: connectorFixture.encryptionPublicKey,
    }, 'preview')).toThrow();
    expect(() => normalizeShieldedIdentity({
      ...connectorFixture,
      coinPublicKey: mismatchedCoinKey,
    }, 'preview')).toThrow('do not match');
  });
});

