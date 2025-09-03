import { describe, it, expect } from 'vitest';
import { AggLayerSDK } from '../index';

describe('AggLayerSDK', () => {
  it('should create an instance', () => {
    const sdk = new AggLayerSDK({
      mode: ['CORE'],
      core: {
        apiBaseUrl: 'http://localhost:3001',
        apiTimeout: 30000,
      },
      lxly: {
        defaultNetwork: 'mainnet',
        chains: [],
        customRpcUrls: {},
      },
    });
    expect(sdk).toBeInstanceOf(AggLayerSDK);
  });
});
