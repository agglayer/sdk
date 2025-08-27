import { describe, it, expect } from 'vitest';
import { AggLayerSDK } from '../index';

describe('AggLayerSDK', () => {
  it('should create an instance', () => {
    const sdk = new AggLayerSDK({});
    expect(sdk).toBeInstanceOf(AggLayerSDK);
  });
});
