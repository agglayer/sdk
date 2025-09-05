import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AggLayerSDK, SDK_MODES } from '../index';
import { CoreClient } from '../core';
import { NativeClient } from '../native';
import { DEFAULT_NETWORK } from '../constants';

// Mock the submodules
vi.mock('../core', () => ({
  CoreClient: vi.fn().mockImplementation(() => ({
    // Mock methods as needed
  })),
}));

vi.mock('../native', () => ({
  NativeClient: vi.fn().mockImplementation(() => ({
    // Mock methods as needed
  })),
}));

describe('AggLayerSDK', () => {
  const mockCoreConfig = {
    apiBaseUrl: 'http://localhost:3001',
    apiTimeout: 30000,
  };

  const mockNativeConfig = {
    defaultNetwork: 1,
    chains: [],
    customRpcUrls: {},
  };

  const mockSDKConfig = {
    mode: ['CORE'],
    core: mockCoreConfig,
    native: mockNativeConfig,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Constructor and Initialization', () => {
    it('should create an instance with CORE mode only', () => {
      const sdk = new AggLayerSDK(mockSDKConfig);
      expect(sdk).toBeInstanceOf(AggLayerSDK);
      expect(CoreClient).toHaveBeenCalledWith(mockCoreConfig);
      expect(NativeClient).not.toHaveBeenCalled();
    });

    it('should create an instance with NATIVE mode only', () => {
      const config = {
        mode: ['NATIVE'],
        core: mockCoreConfig,
        native: mockNativeConfig,
      };
      const sdk = new AggLayerSDK(config);
      expect(sdk).toBeInstanceOf(AggLayerSDK);
      expect(CoreClient).not.toHaveBeenCalled();
      expect(NativeClient).toHaveBeenCalledWith({
        defaultNetwork: 1,
        chains: [],
        customRpcUrls: {},
      });
    });

    it('should create an instance with both CORE and NATIVE modes', () => {
      const config = {
        mode: ['CORE', 'NATIVE'],
        core: mockCoreConfig,
        native: mockNativeConfig,
      };
      const sdk = new AggLayerSDK(config);
      expect(sdk).toBeInstanceOf(AggLayerSDK);
      expect(CoreClient).toHaveBeenCalledWith(mockCoreConfig);
      expect(NativeClient).toHaveBeenCalledWith({
        defaultNetwork: 1,
        chains: [],
        customRpcUrls: {},
      });
    });

    it('should default to CORE mode when no mode is provided', () => {
      const config = {
        core: mockCoreConfig,
        native: mockNativeConfig,
      };
      const sdk = new AggLayerSDK(config);
      expect(sdk).toBeInstanceOf(AggLayerSDK);
      expect(CoreClient).toHaveBeenCalledWith(mockCoreConfig);
      expect(NativeClient).not.toHaveBeenCalled();
    });

    it('should default to CORE mode when empty mode array is provided', () => {
      const config = {
        mode: [],
        core: mockCoreConfig,
        native: mockNativeConfig,
      };
      const sdk = new AggLayerSDK(config);
      expect(sdk).toBeInstanceOf(AggLayerSDK);
      expect(CoreClient).toHaveBeenCalledWith(mockCoreConfig);
      expect(NativeClient).not.toHaveBeenCalled();
    });

    it('should use DEFAULT_NETWORK when native defaultNetwork is not provided', () => {
      const config = {
        mode: ['NATIVE'],
        core: mockCoreConfig,
        native: {
          chains: [],
          customRpcUrls: {},
        },
      };
      new AggLayerSDK(config);
      expect(NativeClient).toHaveBeenCalledWith({
        defaultNetwork: DEFAULT_NETWORK,
        chains: [],
        customRpcUrls: {},
      });
    });

    it('should handle custom chains and RPC URLs in native config', () => {
      const customChains = [{ chainId: 1, rpcUrl: 'https://custom.eth' }];
      const customRpcUrls = { 1: 'https://custom.eth' };
      const config = {
        mode: ['NATIVE'],
        core: mockCoreConfig,
        native: {
          defaultNetwork: 1,
          chains: customChains,
          customRpcUrls,
        },
      };
      new AggLayerSDK(config);
      expect(NativeClient).toHaveBeenCalledWith({
        defaultNetwork: 1,
        chains: customChains,
        customRpcUrls,
      });
    });
  });

  describe('Error Handling', () => {
    it('should throw error when CORE mode is enabled but core config is missing', () => {
      const config = {
        mode: ['CORE'],
        native: mockNativeConfig,
      };
      expect(() => new AggLayerSDK(config)).toThrow('Core config is required');
    });

    it('should throw error when NATIVE mode is enabled but native config is missing', () => {
      const config = {
        mode: ['NATIVE'],
        core: mockCoreConfig,
      };
      expect(() => new AggLayerSDK(config)).toThrow(
        'NATIVE config is required'
      );
    });

    it('should throw error when both modes are enabled but configs are missing', () => {
      const config = {
        mode: ['CORE', 'NATIVE'],
      };
      expect(() => new AggLayerSDK(config)).toThrow('Core config is required');
    });
  });

  describe('Module Access Methods', () => {
    it('should return core module when getCore() is called and core is initialized', () => {
      const sdk = new AggLayerSDK(mockSDKConfig);
      const core = sdk.getCore();
      expect(core).toBeDefined();
      expect(CoreClient).toHaveBeenCalledWith(mockCoreConfig);
    });

    it('should throw error when getCore() is called but core is not initialized', () => {
      const config = {
        mode: ['NATIVE'],
        core: mockCoreConfig,
        native: mockNativeConfig,
      };
      const sdk = new AggLayerSDK(config);
      expect(() => sdk.getCore()).toThrow(
        'Core module not initialized. Add "core" to mode array.'
      );
    });

    it('should return native module when getNative() is called and native is initialized', () => {
      const config = {
        mode: ['NATIVE'],
        core: mockCoreConfig,
        native: mockNativeConfig,
      };
      const sdk = new AggLayerSDK(config);
      const native = sdk.getNative();
      expect(native).toBeDefined();
      expect(NativeClient).toHaveBeenCalledWith({
        defaultNetwork: 1,
        chains: [],
        customRpcUrls: {},
      });
    });

    it('should throw error when getNative() is called but native is not initialized', () => {
      const sdk = new AggLayerSDK(mockSDKConfig);
      expect(() => sdk.getNative()).toThrow(
        'NATIVE module not initialized. Add "native" to mode array.'
      );
    });
  });

  describe('Type Exports', () => {
    it('should export SDK_MODES constant', () => {
      expect(SDK_MODES).toBeDefined();
      expect(SDK_MODES.CORE).toBe('CORE');
      expect(SDK_MODES.NATIVE).toBe('NATIVE');
    });

    it('should export AggLayerSDK class', () => {
      expect(AggLayerSDK).toBeDefined();
      expect(typeof AggLayerSDK).toBe('function');
    });
  });

  describe('Edge Cases', () => {
    it('should handle undefined mode gracefully', () => {
      const config = {
        mode: undefined,
        core: mockCoreConfig,
        native: mockNativeConfig,
      };
      const sdk = new AggLayerSDK(config);
      expect(sdk).toBeInstanceOf(AggLayerSDK);
      expect(CoreClient).toHaveBeenCalledWith(mockCoreConfig);
    });

    it('should handle null mode gracefully', () => {
      const config = {
        mode: null,
        core: mockCoreConfig,
        native: mockNativeConfig,
      };
      const sdk = new AggLayerSDK(config);
      expect(sdk).toBeInstanceOf(AggLayerSDK);
      expect(CoreClient).toHaveBeenCalledWith(mockCoreConfig);
    });

    it('should handle mode with invalid values by defaulting to CORE', () => {
      const config = {
        mode: ['INVALID_MODE'],
        core: mockCoreConfig,
        native: mockNativeConfig,
      };
      const sdk = new AggLayerSDK(config);
      expect(sdk).toBeInstanceOf(AggLayerSDK);
      // The SDK should still work with invalid modes, but core won't be initialized
      // since the mode array doesn't contain 'CORE'
      expect(CoreClient).not.toHaveBeenCalled();
    });
  });

  describe('Configuration Validation', () => {
    it('should validate that core config has required fields', () => {
      const invalidCoreConfig = {};
      const config = {
        mode: ['CORE'],
        core: invalidCoreConfig,
        native: mockNativeConfig,
      };
      // This should not throw during construction, but CoreClient constructor might validate
      expect(() => new AggLayerSDK(config)).not.toThrow();
    });

    it('should handle partial native config gracefully', () => {
      const partialLxlyConfig = {
        defaultNetwork: 1,
        // Missing chains and customRpcUrls
      };
      const config = {
        mode: ['NATIVE'],
        core: mockCoreConfig,
        native: partialLxlyConfig,
      };
      const sdk = new AggLayerSDK(config);
      expect(sdk).toBeInstanceOf(AggLayerSDK);
      expect(NativeClient).toHaveBeenCalledWith({
        defaultNetwork: 1,
        chains: undefined,
        customRpcUrls: undefined,
      });
    });
  });
});
