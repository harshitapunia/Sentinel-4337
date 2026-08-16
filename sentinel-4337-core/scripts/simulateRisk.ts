import { ethers } from "ethers";
import * as dotenv from "dotenv";

dotenv.config({ path: "../frontend/.env.local" }); // Load from frontend where it's already saved

const AAVE_POOL_ABI = [
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
  "function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf) external"
];

const ENTRY_POINT_ABI = [
  "function handleOps(tuple(address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature)[] ops, address beneficiary) external",
  "function getNonce(address sender, uint192 key) view returns (uint256)",
  "function getUserOpHash(tuple(address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature) userOp) view returns (bytes32)"
];

const AAVE_POOL_ADDRESS = "0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951";
const USDC_ADDRESS = "0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8";
const VAULT_ADDRESS = "0x09e0709ad53C9d087668c289A25c3921e0F02277";
const ENTRY_POINT_ADDRESS = "0x433709009B8330FDa32311DF1C2AFA402eD8D009";

async function main() {
  const provider = new ethers.JsonRpcProvider("https://ethereum-sepolia-rpc.publicnode.com");
  
  if (!process.env.PRIVATE_KEY) throw new Error("Missing PRIVATE_KEY in environment variables.");
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

  console.log(`[Simulator] Using wallet: ${wallet.address}`);
  console.log(`[Simulator] Target Vault: ${VAULT_ADDRESS}`);

  const aavePool = new ethers.Contract(AAVE_POOL_ADDRESS, AAVE_POOL_ABI, provider);
  
  console.log("[Simulator] Querying current Aave position...");
  const accountData = await aavePool.getUserAccountData(VAULT_ADDRESS);
  const availableBorrowsBase: bigint = accountData.availableBorrowsBase;
  
  console.log(`[Simulator] Available borrows base (8 decimals USD): ${availableBorrowsBase.toString()}`);
  
  // availableBorrowsBase is in USD (8 decimals). USDC is 6 decimals.
  // We divide by 100 to get the exact USDC amount. 
  // Then multiply by 0.95 to borrow 95% of maximum capacity to safely avoid immediate liquidation reverts.
  const borrowAmount = (availableBorrowsBase / 100n) * 95n / 100n;
  
  if (borrowAmount <= 0n) {
      console.log("[Simulator] No borrowing capacity available. Ensure the vault has supplied collateral first.");
      return;
  }

  console.log(`[Simulator] Calculated risky borrow amount: ${ethers.formatUnits(borrowAmount, 6)} USDC`);

  const borrowData = aavePool.interface.encodeFunctionData("borrow", [
    USDC_ADDRESS,
    borrowAmount,
    2, // Variable interest rate
    0, // referral code
    VAULT_ADDRESS
  ]);

  // Use ERC-7579 BATCH Mode Encoding: 0x01 (Batch) + 31 bytes of zeros
  const BATCH_MODE = "0x0100000000000000000000000000000000000000000000000000000000000000";
  const executionBatch = [
    { target: AAVE_POOL_ADDRESS, value: 0n, callData: borrowData }
  ];

  const executionCalldata = ethers.AbiCoder.defaultAbiCoder().encode(
    ["tuple(address target, uint256 value, bytes callData)[]"],
    [executionBatch]
  );

  const vaultIface = new ethers.Interface(["function execute(bytes32 mode, bytes calldata executionCalldata)"]);
  const callData = vaultIface.encodeFunctionData("execute", [BATCH_MODE, executionCalldata]);

  const entryPoint = new ethers.Contract(ENTRY_POINT_ADDRESS, ENTRY_POINT_ABI, wallet);
  const nonce = await entryPoint.getNonce(VAULT_ADDRESS, 0);

  const feeData = await provider.getFeeData();
  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas || ethers.parseUnits("1", "gwei");
  const maxFeePerGas = feeData.maxFeePerGas || ethers.parseUnits("1.5", "gwei");

  const userOp = {
    sender: VAULT_ADDRESS,
    nonce,
    initCode: "0x",
    callData,
    accountGasLimits: ethers.solidityPacked(["uint128", "uint128"], [300000n, 1000000n]),
    preVerificationGas: 100000n,
    gasFees: ethers.solidityPacked(["uint128", "uint128"], [maxPriorityFeePerGas, maxFeePerGas]),
    paymasterAndData: "0x",
    signature: "0x"
  };

  console.log("[Simulator] Signing UserOp...");
  const userOpHash = await entryPoint.getUserOpHash(userOp);
  userOp.signature = wallet.signingKey.sign(userOpHash).serialized;

  console.log("[Simulator] Submitting Risky Borrow UserOp to EntryPoint...");
  try {
    const tx = await entryPoint.handleOps([userOp], wallet.address, { gasLimit: 1500000n });
    console.log(`[Simulator] Transaction submitted! TX Hash: ${tx.hash}`);
    await tx.wait();
    console.log("[Simulator] Transaction confirmed. Vault is now AT RISK!");
    
    // Fetch new health factor to display it
    const newData = await aavePool.getUserAccountData(VAULT_ADDRESS);
    console.log(`[Simulator] New Health Factor: ${ethers.formatUnits(newData.healthFactor, 18)}`);
  } catch (error) {
    console.error("[Simulator] Execution failed:", error);
  }
}

main().catch(console.error);
