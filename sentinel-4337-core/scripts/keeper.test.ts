import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => {
    process.env.SESSION_KEY_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
    process.env.VAULT_ADDRESS = "0x0000000000000000000000000000000000000001";
    process.env.AAVE_POOL_ADDRESS = "0x0000000000000000000000000000000000000002";
    return {
        mockReadContract: vi.fn(),
        mockRequest: vi.fn()
    };
});

vi.mock('viem', async (importOriginal) => {
    const actual = await importOriginal<typeof import('viem')>();
    return {
        ...actual,
        createPublicClient: vi.fn(() => ({
            readContract: mocks.mockReadContract,
            chain: { id: 11155111 }
        })),
        createClient: vi.fn(() => ({
            request: mocks.mockRequest
        }))
    };
});

// Import keeper AFTER vi.mock to ensure the mock is applied to the module level clients
import { monitor } from './keeper';

describe('Keeper Bot Tests', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('test_Heartbeat_SafeHealthFactor', async () => {
        // Mock health factor 2.0 * 1e18
        mocks.mockReadContract.mockResolvedValue([0n, 0n, 0n, 0n, 0n, 2000000000000000000n]);
        
        await monitor();

        // Should NOT trigger rescue (mockRequest handles bundler calls which executeRescue makes)
        expect(mocks.mockRequest).not.toHaveBeenCalled();
    });

    it('test_Danger_TriggersRescueAndUserOp', async () => {
        // Mock health factor 1.05 * 1e18
        mocks.mockReadContract.mockResolvedValue([0n, 0n, 0n, 0n, 0n, 1050000000000000000n]);

        // Mock bundler requests (pm_sponsorUserOperation and eth_sendUserOperation)
        mocks.mockRequest.mockImplementation(async ({ method, params }: any) => {
            if (method === 'pm_sponsorUserOperation') {
                return { paymasterAndData: '0xmockPaymaster' };
            }
            if (method === 'eth_sendUserOperation') {
                return '0xmockHash';
            }
        });

        await monitor();

        // Check if bundler request was called
        expect(mocks.mockRequest).toHaveBeenCalled();
        
        // Find the eth_sendUserOperation call
        const sendCall = mocks.mockRequest.mock.calls.find((call) => call[0].method === 'eth_sendUserOperation');
        expect(sendCall).toBeDefined();

        const userOp = sendCall[0].params[0];
        
        // Verify ERC-4337 v0.7 compliant structure
        expect(userOp).toHaveProperty('sender');
        expect(userOp).toHaveProperty('nonce');
        expect(userOp).toHaveProperty('initCode');
        expect(userOp).toHaveProperty('callData');
        expect(userOp).toHaveProperty('accountGasLimits');
        expect(userOp).toHaveProperty('preVerificationGas');
        expect(userOp).toHaveProperty('gasFees');
        expect(userOp).toHaveProperty('paymasterAndData');
        expect(userOp).toHaveProperty('signature');
        
        expect(userOp.paymasterAndData).toBe('0xmockPaymaster');
        expect(userOp.signature).not.toBe('0x'); // Should be populated by signing
    });
});
