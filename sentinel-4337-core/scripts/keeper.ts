import { 
    createPublicClient, 
    http, 
    encodeFunctionData, 
    formatEther, 
    encodeAbiParameters, 
    parseAbiParameters, 
    keccak256, 
    concatHex, 
    padHex, 
    Hex, 
    toHex,
    createClient
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import * as dotenv from 'dotenv';
dotenv.config();

// Environment Variables
const RPC_URL = process.env.RPC_URL || '';
const BUNDLER_URL = process.env.BUNDLER_URL || '';
const VAULT_ADDRESS = (process.env.VAULT_ADDRESS || '') as Hex;
const AAVE_POOL_ADDRESS = (process.env.AAVE_POOL_ADDRESS || '') as Hex;
const SESSION_KEY_PK = (process.env.SESSION_KEY_PRIVATE_KEY || '') as Hex;

// Constants
const ENTRYPOINT_V07 = '0x0000000071727De22E5E9d8BAf0edAc6f37da032' as Hex;
const USDC_ADDRESS = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' as Hex; // Sepolia USDC

// Setup Viem Clients
const publicClient = createPublicClient({
    chain: sepolia,
    transport: http(RPC_URL)
});

const bundlerClient = createClient({
    chain: sepolia,
    transport: http(BUNDLER_URL)
});

const keeperAccount = privateKeyToAccount(SESSION_KEY_PK);

// ABIs
const AAVE_POOL_ABI = [{
    inputs: [{ internalType: "address", name: "user", type: "address" }],
    name: "getUserAccountData",
    outputs: [
        { internalType: "uint256", name: "totalCollateralBase", type: "uint256" },
        { internalType: "uint256", name: "totalDebtBase", type: "uint256" },
        { internalType: "uint256", name: "availableBorrowsBase", type: "uint256" },
        { internalType: "uint256", name: "currentLiquidationThreshold", type: "uint256" },
        { internalType: "uint256", name: "ltv", type: "uint256" },
        { internalType: "uint256", name: "healthFactor", type: "uint256" }
    ],
    stateMutability: "view",
    type: "function"
}] as const;

const ERC7579_EXECUTE_ABI = [{
    inputs: [
        { internalType: "bytes32", name: "mode", type: "bytes32" },
        { internalType: "bytes", name: "executionCalldata", type: "bytes" }
    ],
    name: "execute",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
}] as const;

const FLASHLOAN_ABI = [{
    inputs: [
        { internalType: "address", name: "receiverAddress", type: "address" },
        { internalType: "address", name: "asset", type: "address" },
        { internalType: "uint256", name: "amount", type: "uint256" },
        { internalType: "bytes", name: "params", type: "bytes" },
        { internalType: "uint16", name: "referralCode", type: "uint16" }
    ],
    name: "flashLoanSimple",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
}] as const;

let isExecuting = false;
let monitorInterval: NodeJS.Timeout;

async function executeRescue() {
    console.log("⚠️ Executing rescue operation!");
    
    // 1. Calculate debt to repay - in a real bot, we would query the exact debt.
    // For this demonstration, we'll request a flashloan of 1000 USDC.
    const flashLoanAmount = 1000n * 10n**6n; 
    const wethToSell = 5n * 10n**17n; // 0.5 WETH

    // 2. Encode FlashLoan params
    const flashLoanParams = encodeAbiParameters(
        parseAbiParameters('uint256'),
        [wethToSell]
    );

    // 3. Encode the call to Aave Pool
    const callAaveData = encodeFunctionData({
        abi: FLASHLOAN_ABI,
        functionName: 'flashLoanSimple',
        args: [
            VAULT_ADDRESS,
            USDC_ADDRESS,
            flashLoanAmount,
            flashLoanParams,
            0
        ]
    });

    // 4. Encode the ERC-7579 execute format
    // Single execution mode = 0x0100000000000000000000000000000000000000000000000000000000000000
    // Execution calldata: target, value, callData
    const executionCalldata = concatHex([
        AAVE_POOL_ADDRESS,
        padHex('0x0', { size: 32 }),
        callAaveData
    ]);

    const mode = padHex('0x01', { size: 32, dir: 'right' }); // 0x010000...

    const userOpCallData = encodeFunctionData({
        abi: ERC7579_EXECUTE_ABI,
        functionName: 'execute',
        args: [mode, executionCalldata]
    });

    // 5. Construct the PackedUserOperation v0.7
    // These gas limits are estimates for demonstration.
    // A production bot would use `eth_estimateUserOperationGas`.
    const nonce = padHex('0x1', { size: 32 }); // Mock nonce
    const accountGasLimits = concatHex([
        padHex(toHex(2000000n), { size: 16 }), // verificationGasLimit
        padHex(toHex(3000000n), { size: 16 })  // callGasLimit
    ]);
    const gasFees = concatHex([
        padHex(toHex(50000000000n), { size: 16 }), // maxPriorityFeePerGas
        padHex(toHex(50000000000n), { size: 16 })  // maxFeePerGas
    ]);

    const userOp = {
        sender: VAULT_ADDRESS,
        nonce: nonce,
        initCode: '0x' as Hex,
        callData: userOpCallData,
        accountGasLimits: accountGasLimits,
        preVerificationGas: toHex(100000n),
        gasFees: gasFees,
        paymasterAndData: '0x' as Hex, // Self-sponsored or add paymaster here
        signature: '0x' as Hex
    };

    // 6. Get Paymaster Data (Optional step if using standard Bundler like Pimlico)
    console.log("Fetching paymaster sponsorship...");
    try {
        const pmData = await bundlerClient.request({
            method: 'pm_sponsorUserOperation' as any,
            params: [userOp, ENTRYPOINT_V07]
        }) as any;
        
        if (pmData && pmData.paymasterAndData) {
            userOp.paymasterAndData = pmData.paymasterAndData;
            if (pmData.preVerificationGas) userOp.preVerificationGas = pmData.preVerificationGas;
            if (pmData.accountGasLimits) userOp.accountGasLimits = pmData.accountGasLimits;
            if (pmData.gasFees) userOp.gasFees = pmData.gasFees;
        }
    } catch (e) {
        console.log("Paymaster sponsorship failed or unavailable. Proceeding with dummy data.", (e as Error).message);
    }

    // 7. Hash the UserOperation for v0.7
    const chainId = BigInt(publicClient.chain.id);
    const packedForHash = encodeAbiParameters(
        parseAbiParameters('address, uint256, bytes32, bytes32, bytes32, uint256, bytes32, bytes32'),
        [
            userOp.sender,
            BigInt(userOp.nonce),
            keccak256(userOp.initCode),
            keccak256(userOp.callData),
            userOp.accountGasLimits,
            BigInt(userOp.preVerificationGas),
            userOp.gasFees,
            keccak256(userOp.paymasterAndData)
        ]
    );
    const hashToSign = keccak256(
        encodeAbiParameters(
            parseAbiParameters('bytes32, address, uint256'),
            [keccak256(packedForHash), ENTRYPOINT_V07, chainId]
        )
    );

    // 8. Sign UserOp with Session Key
    console.log("Signing UserOp with Keeper Session Key...");
    const signature = await keeperAccount.signMessage({ message: { raw: hashToSign } });
    userOp.signature = signature;

    // 9. Dispatch to Bundler
    console.log("Dispatching to Bundler...");
    try {
        const userOpHash = await bundlerClient.request({
            method: 'eth_sendUserOperation' as any,
            params: [userOp, ENTRYPOINT_V07]
        });
        console.log(`✅ Rescue dispatched successfully! UserOpHash: ${userOpHash}`);
    } catch (e) {
        console.error("❌ Failed to dispatch UserOperation:", (e as Error).message);
    }
}

async function monitor() {
    if (isExecuting) return;
    try {
        const data = await publicClient.readContract({
            address: AAVE_POOL_ADDRESS,
            abi: AAVE_POOL_ABI,
            functionName: 'getUserAccountData',
            args: [VAULT_ADDRESS]
        });

        const healthFactor = data[5];
        const formattedHF = Number(formatEther(healthFactor));

        if (formattedHF > 1.15) {
            console.log(`[SAFE] Health Factor: ${formattedHF.toFixed(4)}. No action required.`);
        } else {
            console.log(`[ALERT] Health Factor dropped to ${formattedHF.toFixed(4)}!`);
            isExecuting = true;
            clearInterval(monitorInterval);
            await executeRescue();
        }
    } catch (e) {
        console.error("Error checking health factor:", (e as Error).message);
    }
}

function start() {
    console.log(`Starting Sentinel Keeper Bot monitoring ${VAULT_ADDRESS}...`);
    monitorInterval = setInterval(monitor, 12000);
}

start();
