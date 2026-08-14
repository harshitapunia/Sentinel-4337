import { ethers } from "ethers";
import * as dotenv from "dotenv";

// Load environment variables (assuming .env or .env.local exists for RPC URLs)
dotenv.config({ path: "../frontend/.env.local" });

// Configuration
const RPC_URL = "https://ethereum-sepolia-rpc.publicnode.com";
const AAVE_POOL_ADDRESS = "0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951";
const VAULT_ADDRESS = "0x6bf444cE0F429510024A2B8f40e2657508cCa5f1";
const POLLING_INTERVAL_MS = 15000; // 15 seconds

// ABIs
const AAVE_POOL_ABI = [
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
  "function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf) external returns (uint256)"
];

const ENTRY_POINT_ABI = [
  "function handleOps(tuple(address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature)[] ops, address beneficiary) external",
  "function getNonce(address sender, uint192 key) view returns (uint256)",
  "function getUserOpHash(tuple(address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature) userOp) view returns (bytes32)"
];

const USDC_ADDRESS = "0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8";
const ENTRY_POINT_ADDRESS = "0x433709009B8330FDa32311DF1C2AFA402eD8D009";

// Threshold configuration (3.5 scaled to 18 decimals)
const DANGER_THRESHOLD = ethers.parseUnits("3.5", 18);

async function triggerRescueOperation(currentHF: bigint) {
  console.log(`\n🚨 [DANGER] Triggering Rescue Operation!`);
  console.log(`Current HF: ${ethers.formatUnits(currentHF, 18)}`);
  console.log(`Threshold:  ${ethers.formatUnits(DANGER_THRESHOLD, 18)}`);
  console.log("-> Proceeding to construct ERC-4337 rescue payload...");
  
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  
  if (!process.env.SESSION_PRIVATE_KEY) {
    const newWallet = ethers.Wallet.createRandom();
    console.error(`\n[ERROR] SESSION_PRIVATE_KEY missing from .env.local!`);
    console.error(`Please add the following to your .env.local:`);
    console.error(`SESSION_PRIVATE_KEY=${newWallet.privateKey}`);
    console.error(`And update KEEPER_BOT_ADDRESS in page.tsx to: ${newWallet.address}`);
    console.error(`Then re-register the session key on the dashboard.`);
    process.exit(1);
  }

  if (!process.env.PRIVATE_KEY) {
    console.error(`[ERROR] PRIVATE_KEY missing from .env.local! Need it to pay gas for submitting handleOps.`);
    process.exit(1);
  }

  const bundlerWallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const sessionWallet = new ethers.Wallet(process.env.SESSION_PRIVATE_KEY, provider);
  
  console.log(`Using Session Key for Signature: ${sessionWallet.address}`);
  console.log(`Using Owner Key as Bundler (Gas Payer): ${bundlerWallet.address}`);

  const aavePool = new ethers.Contract(AAVE_POOL_ADDRESS, AAVE_POOL_ABI, provider);
  // EntryPoint connected to the bundler wallet to pay gas
  const entryPoint = new ethers.Contract(ENTRY_POINT_ADDRESS, ENTRY_POINT_ABI, bundlerWallet);

  // 1. The Rescue Action: Approve and Repay 0.5 USDC
  console.log("Encoding Aave approve() and repay() calls...");
  const repayAmount = ethers.parseUnits("0.5", 6);
  
  const erc20Iface = new ethers.Interface(["function approve(address spender, uint256 amount)"]);
  const approveCalldata = erc20Iface.encodeFunctionData("approve", [AAVE_POOL_ADDRESS, repayAmount]);

  const repayCalldata = aavePool.interface.encodeFunctionData("repay", [
    USDC_ADDRESS,
    repayAmount,
    2, // Variable rate
    VAULT_ADDRESS
  ]);

  // 2. Vault Execution Wrapper (ERC-7579 Batch Execution)
  console.log("Wrapping call for ERC-7579 Vault Batch Execution...");
  const BATCH_EXEC_MODE = "0x0100000000000000000000000000000000000000000000000000000000000000";
  
  const executionBatch = [
    { target: USDC_ADDRESS, value: 0n, callData: approveCalldata },
    { target: AAVE_POOL_ADDRESS, value: 0n, callData: repayCalldata }
  ];

  const executionCalldata = ethers.AbiCoder.defaultAbiCoder().encode(
    ["tuple(address target, uint256 value, bytes callData)[]"],
    [executionBatch]
  );
  
  const vaultInterface = new ethers.Interface([
    "function execute(bytes32 mode, bytes calldata executionCalldata) external"
  ]);
  const userOpCallData = vaultInterface.encodeFunctionData("execute", [
    BATCH_EXEC_MODE,
    executionCalldata
  ]);

  // 3. UserOperation Construction
  const nonce = await entryPoint.getNonce(VAULT_ADDRESS, 0);
  
  const userOp = {
    sender: VAULT_ADDRESS,
    nonce: nonce,
    initCode: "0x",
    callData: userOpCallData,
    accountGasLimits: ethers.concat([
      ethers.zeroPadValue(ethers.toBeHex(300000), 16), // verificationGasLimit
      ethers.zeroPadValue(ethers.toBeHex(800000), 16)  // callGasLimit
    ]),
    preVerificationGas: 100000n,
    gasFees: ethers.concat([
      ethers.zeroPadValue(ethers.toBeHex(ethers.parseUnits("5", "gwei")), 16), // maxPriorityFee
      ethers.zeroPadValue(ethers.toBeHex(ethers.parseUnits("15", "gwei")), 16) // maxFee
    ]),
    paymasterAndData: "0x",
    signature: "0x"
  };

  // 4. Session Key Authentication
  console.log("Signing UserOp with Session Key...");
  const userOpHash = await entryPoint.getUserOpHash(userOp);
  // As clarified in our plan, SentinelVault natively supports raw Session Key signatures 
  // via _rawSignatureValidation, so no module prefix is needed!
  userOp.signature = sessionWallet.signingKey.sign(userOpHash).serialized;

  // 4.5. Ensure Vault has enough gas deposited in the EntryPoint
  console.log("Checking Vault's EntryPoint prefund balance...");
  const epDepositABI = ["function balanceOf(address account) view returns (uint256)", "function depositTo(address account) payable"];
  const epDepositContract = new ethers.Contract(ENTRY_POINT_ADDRESS, epDepositABI, bundlerWallet);
  const vaultBalance = await epDepositContract.balanceOf(VAULT_ADDRESS);
  console.log(`Vault EntryPoint Balance: ${ethers.formatEther(vaultBalance)} ETH`);
  
  if (vaultBalance < ethers.parseEther("0.02")) {
    console.log("Funding Vault EntryPoint balance with 0.01 ETH from Bundler Wallet...");
    const depTx = await epDepositContract.depositTo(VAULT_ADDRESS, { value: ethers.parseEther("0.01") });
    await depTx.wait();
    console.log("Prefund deposited!");
  }

  // 5. Submission
  console.log("Submitting Rescue UserOp to EntryPoint...");
  try {
    const tx = await entryPoint.handleOps([userOp], bundlerWallet.address, {
      gasLimit: 3000000n
    });
    console.log(`Rescue Transaction submitted! TX Hash: ${tx.hash}`);
    await tx.wait();
    console.log(`Rescue Operation confirmed!`);
  } catch (error) {
    console.error("Failed to execute rescue UserOp:", error);
  }
}

async function monitorHealthFactor() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const aavePool = new ethers.Contract(AAVE_POOL_ADDRESS, AAVE_POOL_ABI, provider);

  console.log(`[KeeperBot] Starting state monitor...`);
  console.log(`[KeeperBot] Target Vault: ${VAULT_ADDRESS}`);
  console.log(`[KeeperBot] Danger Threshold: ${ethers.formatUnits(DANGER_THRESHOLD, 18)}`);
  console.log("--------------------------------------------------");

  let isMonitoring = true;

  while (isMonitoring) {
    try {
      // 1. Fetch user account data from Aave
      const accountData = await aavePool.getUserAccountData(VAULT_ADDRESS);
      const currentHealthFactor: bigint = accountData.healthFactor;

      console.log(`[${new Date().toISOString()}] Current Health Factor: ${
        currentHealthFactor === ethers.MaxUint256 
          ? "∞ (No Debt)" 
          : ethers.formatUnits(currentHealthFactor, 18)
      }`);

      // 2. Evaluate Logic
      if (currentHealthFactor !== ethers.MaxUint256 && currentHealthFactor < DANGER_THRESHOLD) {
        // 3. Trigger Rescue
        isMonitoring = false; // Break the monitoring loop
        await triggerRescueOperation(currentHealthFactor);
        break; 
      }

    } catch (error) {
      console.error(`[Error] Failed to fetch health factor:`, error);
    }

    // Wait for the next tick if we haven't triggered a rescue
    if (isMonitoring) {
      await new Promise(resolve => setTimeout(resolve, POLLING_INTERVAL_MS));
    }
  }

  console.log("[KeeperBot] Monitoring loop exited.");
}

// Start the monitor if this script is executed directly
if (require.main === module) {
  monitorHealthFactor().catch(console.error);
}
