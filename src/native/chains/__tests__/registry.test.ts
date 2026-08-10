import { describe, it, expect } from 'vitest';
import { ChainRegistry, chainRegistry } from '../registry';

/**
 * ChainRegistry networkId-collision precedence.
 *
 * Background: the SDK pre-seeds default chains (Ethereum mainnet at
 * networkId 0, Katana at networkId 20, Sepolia at networkId 0) at
 * construction time. A consumer registering their own chain at a colliding
 * networkId (e.g. a devnet L1 also at networkId 0, per
 * `agglayer-dev-ui/app/context/aggLayerSdk.tsx`) must have that
 * registration win over the built-in default — regardless of registration
 * order — so `getChainByNetworkId()` (and everything that depends on it:
 * `BridgeUtil.fromNetworkId`, `AggkitBridgeAggregator.getTokenMetadata`)
 * never silently falls back to a default chain's RPC/nativeCurrency.
 *
 * Each test below constructs a *fresh* `ChainRegistry` instance (bypassing
 * the private constructor) instead of mutating the shared `chainRegistry`
 * singleton, so these tests are self-contained and order-independent.
 */
function freshRegistry(): ChainRegistry {
  // `ChainRegistry`'s constructor is intentionally private (consumers use
  // the exported `chainRegistry` singleton) — bypass it here purely for
  // test isolation, so registering a colliding devnet chain in one test
  // can't leak into another.
  return new (ChainRegistry as unknown as new () => ChainRegistry)();
}

const DEVNET_L1 = {
  chainId: 1337,
  networkId: 0,
  name: 'Devnet L1',
  rpcUrl: 'http://localhost:8545',
  nativeCurrency: { name: 'Devnet Ether', symbol: 'dETH', decimals: 18 },
};

describe('ChainRegistry networkId collision precedence', () => {
  it('a consumer-registered chain at networkId 0 wins over the pre-seeded Ethereum mainnet default', () => {
    const registry = freshRegistry();

    registry.registerChain(DEVNET_L1);

    const resolved = registry.getChainByNetworkId(0);

    expect(resolved.chainId).toBe(DEVNET_L1.chainId);
    expect(resolved.name).toBe('Devnet L1');
    expect(resolved.rpcUrl).toBe('http://localhost:8545');
    expect(resolved.rpcUrl).not.toBe('https://eth.llamarpc.com');
  });

  it('precedence holds regardless of registration order (registering the override "late" still wins)', () => {
    const registry = freshRegistry();

    // Register some unrelated chains first, to rule out "last registered
    // wins" being the actual mechanism (it must specifically be
    // "consumer beats default", not just insertion order).
    registry.registerChain({
      ...DEVNET_L1,
      chainId: 9999,
      networkId: 55,
      name: 'Unrelated Chain',
    });
    registry.registerChain(DEVNET_L1);

    expect(registry.getChainByNetworkId(0).chainId).toBe(DEVNET_L1.chainId);
  });

  it('is order-independent the other way too: default re-seeded conceptually first still loses to a consumer override registered afterward', () => {
    const registry = freshRegistry();

    // Defaults are always seeded first (constructor). Registering the
    // consumer override afterward (the only real-world order) must still
    // resolve to the consumer's chain, not the default.
    expect(registry.getChainByNetworkId(0).name).toBe('Ethereum');
    registry.registerChain(DEVNET_L1);
    expect(registry.getChainByNetworkId(0).name).toBe('Devnet L1');
  });

  it('regression: with no override registered, default chains resolve exactly as before', () => {
    const registry = freshRegistry();

    const mainnet = registry.getChainByNetworkId(0);
    expect(mainnet.chainId).toBe(1);
    expect(mainnet.name).toBe('Ethereum');
    expect(mainnet.rpcUrl).toBe('https://eth.llamarpc.com');

    const katana = registry.getChainByNetworkId(20);
    expect(katana.chainId).toBe(747474);
    expect(katana.name).toBe('Katana');

    expect(registry.getChain(1).name).toBe('Ethereum');
    expect(registry.getChain(747474).name).toBe('Katana');
    expect(registry.getChain(11155111).name).toBe('Ethereum Sepolia');
    expect(registry.getSupportedChainIds().sort((a, b) => a - b)).toEqual(
      [1, 747474, 11155111].sort((a, b) => a - b)
    );
    expect(registry.isChainSupportedByNetworkId(0)).toBe(true);
  });

  it('throws with the original "not found" message when neither an override nor a default share the networkId', () => {
    const registry = freshRegistry();

    expect(() => registry.getChainByNetworkId(999)).toThrow(
      /Chain with network ID 999 not found/
    );
  });

  it('the exported singleton is unaffected by fresh test instances (sanity: singleton still resolves mainnet by default)', () => {
    expect(chainRegistry.getChainByNetworkId(0).chainId).toBe(1);
  });
});
