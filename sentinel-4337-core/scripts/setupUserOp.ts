import { ethers } from "ethers";
import * as dotenv from "dotenv";

dotenv.config({ path: "../frontend/.env.local" }); // Load from frontend where it's already saved

// ABIs
const WETH_ABI = [
  "function mint(address account, uint256 amount) external",
  "function transfer(address to, uint256 amount) external returns (bool)",
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function deposit() payable"
];
const AAVE_POOL_ABI = [
  "function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external",
  "function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf) external"
];
const ENTRY_POINT_ABI = [
  "function handleOps(tuple(address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature)[] ops, address beneficiary) external",
  "function getNonce(address sender, uint192 key) view returns (uint256)",
  "function getUserOpHash(tuple(address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature) userOp) view returns (bytes32)"
];

const WETH_ADDRESS = "0xC558DBdd856501FCd9aaF1E62eae57A9F0629a3c";
const AAVE_POOL_ADDRESS = "0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951";
const USDC_ADDRESS = "0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8"; // Sepolia USDC
const VAULT_ADDRESS = "0x09e0709ad53C9d087668c289A25c3921e0F02277";
const ENTRY_POINT_ADDRESS = "0x433709009B8330FDa32311DF1C2AFA402eD8D009";

async function main() {
  const provider = new ethers.JsonRpcProvider("https://ethereum-sepolia-rpc.publicnode.com");
  
  // ⚠️ WARNING: Ensure you have your private key in your .env file
  if (!process.env.PRIVATE_KEY) {
    throw new Error("Missing PRIVATE_KEY in environment variables.");
  }
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

  console.log(`Using wallet: ${wallet.address}`);

  // ==========================================
  // Step 1: Mint Test WETH to your wallet
  // ==========================================
  const weth = new ethers.Contract(WETH_ADDRESS, WETH_ABI, wallet);
  const amountToMint = ethers.parseEther("0.015"); // Wrap 0.015 WETH for sufficient collateral
  
  console.log("Wrapping 0.015 Sepolia ETH to WETH...");
  try {
    const depositTx = await weth.deposit({ value: amountToMint });
    await depositTx.wait();
    console.log("WETH Wrapped successfully!");
  } catch (err: any) {
    console.error("Deposit failed:", err);
    throw err;
  }

  // ==========================================
  // Step 2: Send WETH to Vault
  // ==========================================
  console.log(`Transferring 0.015 WETH to Vault (${VAULT_ADDRESS})...`);
  const transferTx = await weth.transfer(VAULT_ADDRESS, amountToMint);
  await transferTx.wait();
  console.log("Transfer to Vault complete.");

  // ==========================================
  // Step 3: Create UserOp to Supply & Borrow
  // ==========================================
  
  // --- VERIFICATION: Check on-chain balances ---
  const vaultWethBalance = await weth.balanceOf(VAULT_ADDRESS);
  console.log(`[ON-CHAIN] Vault WETH Balance: ${ethers.formatEther(vaultWethBalance)} WETH`);
  
  const epContractForBalance = new ethers.Contract(ENTRY_POINT_ADDRESS, ["function balanceOf(address account) view returns (uint256)"], provider);
  const vaultEpBalance = await epContractForBalance.balanceOf(VAULT_ADDRESS);
  console.log(`[ON-CHAIN] Vault EntryPoint Balance: ${ethers.formatEther(vaultEpBalance)} ETH`);
  // ---------------------------------------------

  console.log("Preparing UserOperation...");
  
  const aavePool = new ethers.Contract(AAVE_POOL_ADDRESS, AAVE_POOL_ABI);
  const supplyAmount = ethers.parseEther("0.015"); // Supply 0.015 WETH
  const supplyData = aavePool.interface.encodeFunctionData("supply", [
    WETH_ADDRESS,
    supplyAmount,
    VAULT_ADDRESS,
    0
  ]);
  
  // Let's borrow 1 USDC (0.001 WETH is ~$2.60, so 1 USDC is a safe borrow)
  const borrowAmount = ethers.parseUnits("1", 6); // USDC is 6 decimals
  const borrowData = aavePool.interface.encodeFunctionData("borrow", [
    USDC_ADDRESS,
    borrowAmount,
    2, // Variable interest rate
    0, // referral code
    VAULT_ADDRESS
  ]);

  // The vault needs to: 1. Approve Aave to spend WETH, 2. Supply WETH, 3. Borrow USDC
  const approveData = weth.interface.encodeFunctionData("approve", [AAVE_POOL_ADDRESS, supplyAmount]);

  // ERC-7579 BATCH Mode Encoding: 0x01 (Batch) + 31 bytes of zeros
  const BATCH_MODE = "0x0100000000000000000000000000000000000000000000000000000000000000";
  
  const executionBatch = [
    { target: WETH_ADDRESS, value: 0n, callData: approveData },
    { target: AAVE_POOL_ADDRESS, value: 0n, callData: supplyData },
    { target: AAVE_POOL_ADDRESS, value: 0n, callData: borrowData }
  ];

  // Encode the array for executionCalldata
  const executionCalldata = ethers.AbiCoder.defaultAbiCoder().encode(
    ["tuple(address target, uint256 value, bytes callData)[]"],
    [executionBatch]
  );

  // Vault execute selector: `execute(bytes32 mode, bytes calldata executionCalldata)`
  const vaultExecuteAbi = ["function execute(bytes32 mode, bytes calldata executionCalldata)"];
  const vaultIface = new ethers.Interface(vaultExecuteAbi);
  const callData = vaultIface.encodeFunctionData("execute", [BATCH_MODE, executionCalldata]);

  // Get EntryPoint Nonce
  const entryPoint = new ethers.Contract(ENTRY_POINT_ADDRESS, ENTRY_POINT_ABI, wallet);
  const nonce = await entryPoint.getNonce(VAULT_ADDRESS, 0);

  // Pack Gas Limits (ERC-4337 v0.7)
  const verificationGasLimit = 300000n; // Safe margin for ECDSA + hook validation
  const callGasLimit = 1000000n; // Aave supply + borrow requires significant gas
  const accountGasLimits = ethers.solidityPacked(["uint128", "uint128"], [verificationGasLimit, callGasLimit]);

  // Fees
  const feeData = await provider.getFeeData();
  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas || ethers.parseUnits("1", "gwei");
  const maxFeePerGas = feeData.maxFeePerGas || ethers.parseUnits("1.5", "gwei");
  const gasFees = ethers.solidityPacked(["uint128", "uint128"], [maxPriorityFeePerGas, maxFeePerGas]);

  const userOp = {
    sender: VAULT_ADDRESS,
    nonce,
    initCode: "0x", // Vault already deployed
    callData,
    accountGasLimits,
    preVerificationGas: 100000n,
    gasFees,
    paymasterAndData: "0x",
    signature: "0x"
  };

  // Sign UserOp Hash
  console.log("Signing UserOp...");
  // Get the exact hash from the EntryPoint contract directly
  const userOpHash = await entryPoint.getUserOpHash(userOp);
  const signature = wallet.signingKey.sign(userOpHash).serialized;
  userOp.signature = signature;

  // Deposit ETH to EntryPoint for the Vault to pay for its own UserOp gas
  console.log("Depositing 0.005 ETH to EntryPoint for the Vault...");
  const epContract = new ethers.Contract(ENTRY_POINT_ADDRESS, ["function depositTo(address account) payable"], wallet);
  const depositEpTx = await epContract.depositTo(VAULT_ADDRESS, { value: ethers.parseEther("0.005") });
  await depositEpTx.wait();
  console.log("EntryPoint deposit complete.");

  // Submit via handleOps to the EntryPoint from the wallet (self-submitting)
  console.log("Submitting UserOp to EntryPoint...");
  const handleOpsTx = await entryPoint.handleOps([userOp], wallet.address, {
    gasLimit: 1500000n // Slightly increased to ensure the bundle wrapper doesn't fail
  });
  
  console.log(`Transaction submitted! TX Hash: ${handleOpsTx.hash}`);
  await handleOpsTx.wait();
  console.log("Transaction confirmed. Vault is now supplying WETH and borrowing USDC on Aave!");
}

main().catch(console.error);
