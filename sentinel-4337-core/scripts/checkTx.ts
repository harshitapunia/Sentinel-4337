import { ethers } from "ethers";

async function main() {
  const provider = new ethers.JsonRpcProvider("https://ethereum-sepolia-rpc.publicnode.com");
  const txHash = "0x2ed53ddc3c9284de0c4940474a8bb33f7e8e59dd7973e68f129084d67da633ef";
  const receipt = await provider.getTransactionReceipt(txHash);
  
  if (!receipt) {
    console.log("No receipt found");
    return;
  }

  const epIface = new ethers.Interface([
    "event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)",
    "event UserOperationRevertReason(bytes32 indexed userOpHash, address indexed sender, uint256 nonce, bytes revertReason)"
  ]);

  for (const log of receipt.logs) {
    try {
      const parsed = epIface.parseLog({ topics: log.topics as string[], data: log.data });
      if (parsed) {
        console.log("Event:", parsed.name, parsed.args);
        if (parsed.name === "UserOperationRevertReason") {
          console.log("Revert reason hex:", parsed.args.revertReason);
          try {
            // Try to decode standard Error(string)
            const reason = ethers.AbiCoder.defaultAbiCoder().decode(["string"], "0x" + parsed.args.revertReason.slice(10));
            console.log("Decoded reason:", reason);
          } catch (e) {
            console.log("Could not decode string. Might be custom error.");
          }
        }
      }
    } catch (e) {}
  }
}

main().catch(console.error);
