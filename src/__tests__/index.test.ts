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
    it('should create an instance with no config (undefined)', () => {
      const sdk = new AggLayerSDK();
      expect(sdk).toBeInstanceOf(AggLayerSDK);
      expect(CoreClient).toHaveBeenCalledWith(undefined);
      expect(NativeClient).not.toHaveBeenCalled();
    });

    it('should create an instance with empty config object', () => {
      const sdk = new AggLayerSDK({});
      expect(sdk).toBeInstanceOf(AggLayerSDK);
      expect(CoreClient).toHaveBeenCalledWith(undefined);
      expect(NativeClient).not.toHaveBeenCalled();
    });

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
      // When mode is undefined/not provided, defaults to CORE mode
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

    it('should use undefined core config when only mode is provided', () => {
      const config = {
        mode: [SDK_MODES.CORE],
      };
      const sdk = new AggLayerSDK(config);
      expect(sdk).toBeInstanceOf(AggLayerSDK);
      expect(CoreClient).toHaveBeenCalledWith(undefined);
      expect(NativeClient).not.toHaveBeenCalled();
    });

    it('should use default native config when NATIVE mode is provided without native config', () => {
      const config = {
        mode: [SDK_MODES.NATIVE],
      };
      const sdk = new AggLayerSDK(config);
      expect(sdk).toBeInstanceOf(AggLayerSDK);
      expect(CoreClient).not.toHaveBeenCalled();
      expect(NativeClient).toHaveBeenCalledWith({
        defaultNetwork: DEFAULT_NETWORK,
      });
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

  describe('Flexible Configuration', () => {
    it('should handle minimal config with just core overrides', () => {
      const config = {
        core: { apiBaseUrl: 'https://custom-api.com' },
      };
      const sdk = new AggLayerSDK(config);
      expect(sdk).toBeInstanceOf(AggLayerSDK);
      expect(CoreClient).toHaveBeenCalledWith({
        apiBaseUrl: 'https://custom-api.com',
      });
      expect(NativeClient).not.toHaveBeenCalled();
    });

    it('should handle minimal config with just native overrides', () => {
      const config = {
        mode: [SDK_MODES.NATIVE],
        native: { defaultNetwork: 137 },
      };
      const sdk = new AggLayerSDK(config);
      expect(sdk).toBeInstanceOf(AggLayerSDK);
      expect(CoreClient).not.toHaveBeenCalled();
      expect(NativeClient).toHaveBeenCalledWith({
        defaultNetwork: 137,
      });
    });

    it('should merge user config with defaults for both modes', () => {
      const config = {
        mode: [SDK_MODES.CORE, SDK_MODES.NATIVE],
        core: { apiTimeout: 5000 },
        native: {
          defaultNetwork: 1,
          chains: [{ chainId: 1, name: 'Ethereum' }],
        },
      };
      const sdk = new AggLayerSDK(config);
      expect(sdk).toBeInstanceOf(AggLayerSDK);
      expect(CoreClient).toHaveBeenCalledWith({ apiTimeout: 5000 });
      expect(NativeClient).toHaveBeenCalledWith({
        defaultNetwork: 1,
        chains: [{ chainId: 1, name: 'Ethereum' }],
      });
    });

    it('should work with partial native config', () => {
      const config = {
        mode: [SDK_MODES.NATIVE],
        native: {
          chains: [{ chainId: 137, name: 'Polygon' }],
          // defaultNetwork should use DEFAULT_NETWORK
        },
      };
      const sdk = new AggLayerSDK(config);
      expect(sdk).toBeInstanceOf(AggLayerSDK);
      expect(NativeClient).toHaveBeenCalledWith({
        defaultNetwork: DEFAULT_NETWORK,
        chains: [{ chainId: 137, name: 'Polygon' }],
      });
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
    it('should handle undefined mode gracefully - defaults to CORE mode', () => {
      const config = {
        mode: undefined,
        core: mockCoreConfig,
        native: mockNativeConfig,
      };
      const sdk = new AggLayerSDK(config);
      expect(sdk).toBeInstanceOf(AggLayerSDK);
      expect(CoreClient).toHaveBeenCalledWith(mockCoreConfig);
      expect(NativeClient).not.toHaveBeenCalled();
    });

    it('should handle null mode gracefully - defaults to CORE mode', () => {
      const config = {
        mode: null,
        core: mockCoreConfig,
        native: mockNativeConfig,
      };
      const sdk = new AggLayerSDK(config);
      expect(sdk).toBeInstanceOf(AggLayerSDK);
      expect(CoreClient).toHaveBeenCalledWith(mockCoreConfig);
      expect(NativeClient).not.toHaveBeenCalled();
    });

    it('should handle mode with invalid values - no modules initialized', () => {
      const config = {
        mode: ['INVALID_MODE'],
        core: mockCoreConfig,
        native: mockNativeConfig,
      };
      const sdk = new AggLayerSDK(config);
      expect(sdk).toBeInstanceOf(AggLayerSDK);
      // Invalid modes don't initialize any modules
      expect(CoreClient).not.toHaveBeenCalled();
      expect(NativeClient).not.toHaveBeenCalled();
    });
  });

  describe('Default Configuration Behavior', () => {
    it('should use undefined core config when none provided', () => {
      const config = {
        mode: [SDK_MODES.CORE],
      };
      const sdk = new AggLayerSDK(config);
      expect(sdk).toBeInstanceOf(AggLayerSDK);
      expect(CoreClient).toHaveBeenCalledWith(undefined);
    });

    it('should use default native config when none provided', () => {
      const config = {
        mode: [SDK_MODES.NATIVE],
      };
      const sdk = new AggLayerSDK(config);
      expect(sdk).toBeInstanceOf(AggLayerSDK);
      expect(NativeClient).toHaveBeenCalledWith({
        defaultNetwork: DEFAULT_NETWORK,
      });
    });

    it('should handle partial native config gracefully', () => {
      const partialNativeConfig = {
        defaultNetwork: 1,
        // Missing chains and customRpcUrls
      };
      const config = {
        mode: [SDK_MODES.NATIVE],
        native: partialNativeConfig,
      };
      const sdk = new AggLayerSDK(config);
      expect(sdk).toBeInstanceOf(AggLayerSDK);
      expect(NativeClient).toHaveBeenCalledWith({
        defaultNetwork: 1,
      });
    });

    it('should preserve user-provided config values', () => {
      const userCoreConfig = {
        apiBaseUrl: 'https://custom.api',
        apiTimeout: 10000,
      };
      const userNativeConfig = {
        defaultNetwork: 137,
        chains: [{ chainId: 137 }],
        customRpcUrls: { 137: 'https://polygon-rpc.com' },
      };
      const config = {
        mode: [SDK_MODES.CORE, SDK_MODES.NATIVE],
        core: userCoreConfig,
        native: userNativeConfig,
      };
      const sdk = new AggLayerSDK(config);
      expect(sdk).toBeInstanceOf(AggLayerSDK);
      expect(CoreClient).toHaveBeenCalledWith(userCoreConfig);
      expect(NativeClient).toHaveBeenCalledWith({
        defaultNetwork: 137,
        chains: [{ chainId: 137 }],
        customRpcUrls: { 137: 'https://polygon-rpc.com' },
      });
    });

    it('should handle deeply nested config merging correctly', () => {
      const config = {
        mode: [SDK_MODES.NATIVE],
        native: {
          customRpcUrls: { 1: 'https://eth-mainnet.custom' },
          // Missing defaultNetwork and chains
        },
      };
      const sdk = new AggLayerSDK(config);
      expect(sdk).toBeInstanceOf(AggLayerSDK);
      expect(NativeClient).toHaveBeenCalledWith({
        defaultNetwork: DEFAULT_NETWORK,
        customRpcUrls: { 1: 'https://eth-mainnet.custom' },
      });
    });

    it('should work with falsy but valid config values', () => {
      const config = {
        mode: [SDK_MODES.NATIVE],
        native: {
          defaultNetwork: 0, // Falsy but valid network ID
        },
      };
      const sdk = new AggLayerSDK(config);
      expect(sdk).toBeInstanceOf(AggLayerSDK);
      expect(NativeClient).toHaveBeenCalledWith({
        defaultNetwork: 0, // Should preserve the 0 value, not use DEFAULT_NETWORK
      });
    });
  });
});
