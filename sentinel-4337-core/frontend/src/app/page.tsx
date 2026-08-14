"use client";

import { useAccount, useConnect, useDisconnect, useReadContract, useWriteContract, useWaitForTransactionReceipt, useBlockNumber, useSwitchChain, usePublicClient } from 'wagmi';
import { sepolia } from 'wagmi/chains';
import { injected } from 'wagmi/connectors';
import { FACTORY_ABI, VAULT_ABI, AAVE_POOL_ABI } from '../config/abis';
import { useState, useEffect, useCallback } from 'react';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const SEPOLIA_RPC = 'https://ethereum-sepolia-rpc.publicnode.com';
const ENTRY_POINT_ADDRESS = '0x433709009B8330FDa32311DF1C2AFA402eD8D009';

export default function Dashboard() {
  const [mounted, setMounted] = useState(false);
  const [isVaultDeployed, setIsVaultDeployed] = useState(false);
  const [codeCheckDone, setCodeCheckDone] = useState(false);

  const { isConnected, address, chain } = useAccount();
  const { connect, error: connectError } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChainAsync } = useSwitchChain();
  const publicClient = usePublicClient();
  
  const [recentEvents, setRecentEvents] = useState<any[]>([]);
  const [totalGasSponsored, setTotalGasSponsored] = useState<bigint>(BigInt(0));
  const [logsLoading, setLogsLoading] = useState(false);

  const isWrongChain = isConnected && chain?.id !== sepolia.id;

  // Force cache busting on new blocks
  const { data: blockNumber } = useBlockNumber({ watch: true });

  // Prevent SSR/Hydration mismatch
  useEffect(() => {
    setMounted(true);
  }, []);

  const handleConnect = async () => {
    try {
      connect({ connector: injected() });
    } catch (err) {
      console.warn("Wagmi connect fallback triggered:", err);
      if (typeof window !== "undefined" && (window as any).ethereum) {
        await (window as any).ethereum.request({ method: "eth_requestAccounts" });
      } else {
        alert("MetaMask extension not detected in browser!");
      }
    }
  };

  // Mocks for derived metrics
  // (Removed hardcoded healthFactor = "1.85")

  // Step 1: Get the deterministic predicted address from the factory
  const { data: predictedVaultAddress, refetch: refetchVaultAddress } = useReadContract({
    address: process.env.NEXT_PUBLIC_VAULT_FACTORY_ADDRESS as `0x${string}`,
    abi: FACTORY_ABI,
    functionName: 'getAddress',
    args: address ? [address, BigInt(0)] : undefined,
    query: { enabled: !!address },
  });

  // Step 2: Raw eth_getCode check via fetch — completely bypasses Wagmi/Viem caching
  const checkVaultCode = useCallback(async (vaultAddr: string) => {
    try {
      const res = await fetch(SEPOLIA_RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_getCode',
          params: [vaultAddr, 'latest'],
        }),
      });
      const json = await res.json();
      const code = json?.result;
      const deployed = !!code && code !== '0x' && code !== '0x0';
      console.log(`[Sentinel] eth_getCode(${vaultAddr}):`, code?.slice(0, 20) + '...', '| deployed:', deployed);
      setIsVaultDeployed(deployed);
      setCodeCheckDone(true);
    } catch (err) {
      console.error('[Sentinel] eth_getCode fetch failed:', err);
      setIsVaultDeployed(false);
      setCodeCheckDone(true);
    }
  }, []);

  // Re-check vault code whenever predicted address or block number changes
  useEffect(() => {
    if (predictedVaultAddress && predictedVaultAddress !== ZERO_ADDRESS) {
      checkVaultCode(predictedVaultAddress as string);
    } else {
      setIsVaultDeployed(false);
      setCodeCheckDone(true);
    }
  }, [predictedVaultAddress, blockNumber, checkVaultCode]);

  const KEEPER_BOT_ADDRESS = "0x97F51f58bFFD19CAB9e83e5442048cEC1e62e26d";

  const { data: sessionExpiry } = useReadContract({
    address: predictedVaultAddress as `0x${string}`,
    abi: VAULT_ABI,
    functionName: 'sessionKeys',
    args: [KEEPER_BOT_ADDRESS],
    query: { enabled: isVaultDeployed },
  });

  const isSessionActive = !!sessionExpiry && Number(sessionExpiry) > Math.floor(Date.now() / 1000);

  const { data: aaveAccountData, refetch: refetchAaveData } = useReadContract({
    address: '0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951', // Aave V3 Sepolia Pool
    abi: AAVE_POOL_ABI,
    functionName: 'getUserAccountData',
    args: predictedVaultAddress ? [predictedVaultAddress] : undefined,
    query: { enabled: isVaultDeployed && !!predictedVaultAddress },
  });

  // Auto-refresh Aave data every 10 seconds
  useEffect(() => {
    if (!isVaultDeployed) return;
    const interval = setInterval(() => {
      refetchAaveData();
    }, 10000);
    return () => clearInterval(interval);
  }, [isVaultDeployed, refetchAaveData]);

  const healthFactorDisplay = (() => {
    if (!aaveAccountData) return null;
    const [, totalDebtBase, , , , healthFactor] = aaveAccountData as any;
    if (totalDebtBase === BigInt(0)) return "∞";
    return (Number(healthFactor) / 1e18).toFixed(2);
  })();

  const totalValueProtectedDisplay = (() => {
    if (!aaveAccountData) return "0.00";
    const [totalCollateralBase] = aaveAccountData as any;
    // Aave V3 USD base is 8 decimals
    return (Number(totalCollateralBase) / 1e8).toFixed(2);
  })();

  // Log state for debugging
  useEffect(() => {
    if (address) {
      console.log('[Sentinel] Connected Wallet:', address);
      console.log('[Sentinel] Factory Address:', process.env.NEXT_PUBLIC_VAULT_FACTORY_ADDRESS);
      console.log('[Sentinel] Predicted Vault:', predictedVaultAddress);
      console.log('[Sentinel] isVaultDeployed:', isVaultDeployed);
      console.log('[Sentinel] Block:', blockNumber?.toString());
    }
  }, [address, predictedVaultAddress, isVaultDeployed, blockNumber]);

  // Write contract with proper error extraction
  const { writeContract, data: txHash, error: writeError, isPending: isWriting, reset: resetWrite } = useWriteContract();
  const { isLoading: isConfirming, isSuccess: isDeploySuccess, isError: isTxError, error: txError } = useWaitForTransactionReceipt({ hash: txHash });

  const isDeploying = isWriting || isConfirming;

  // After successful deploy, force a recheck
  useEffect(() => {
    if (isDeploySuccess && predictedVaultAddress) {
      console.log('[Sentinel] Deploy TX confirmed! Force re-checking vault code...');
      refetchVaultAddress();
      // Small delay to let the node index the new contract
      setTimeout(() => {
        checkVaultCode(predictedVaultAddress as string);
      }, 2000);
    }
  }, [isDeploySuccess, predictedVaultAddress, refetchVaultAddress, checkVaultCode]);

  const ensureSepolia = async () => {
    if (chain?.id !== sepolia.id) {
      console.log('[Sentinel] Wrong chain detected:', chain?.id, '— switching to Sepolia...');
      await switchChainAsync({ chainId: sepolia.id });
    }
  };

  const handleDeploy = async () => {
    if (!address) return;
    resetWrite();
    try {
      await ensureSepolia();
      writeContract({
        address: process.env.NEXT_PUBLIC_VAULT_FACTORY_ADDRESS as `0x${string}`,
        abi: FACTORY_ABI,
        functionName: 'createAccount',
        args: [address, BigInt(0)],
        chainId: sepolia.id,
      });
    } catch (err) {
      console.error('[Sentinel] Chain switch or deploy failed:', err);
    }
  };

  const handleApproveSessionKey = async () => {
    if (!predictedVaultAddress) return;
    const validUntil = Math.floor(Date.now() / 1000) + 86400 * 365; // 1 year
    resetWrite();
    try {
      await ensureSepolia();
      writeContract({
        address: predictedVaultAddress,
        abi: VAULT_ABI,
        functionName: 'registerSessionKey',
        args: [KEEPER_BOT_ADDRESS, validUntil],
        chainId: sepolia.id,
      });
    } catch (err) {
      console.error('[Sentinel] Chain switch or session key failed:', err);
    }
  };

  // Fetch Logs from EntryPoint
  useEffect(() => {
    let mounted = true;
    async function fetchLogs(isInitial = false) {
      if (!publicClient || !predictedVaultAddress || !isVaultDeployed) return;
      if (isInitial) setLogsLoading(true);
      
      try {
        const currentBlock = await publicClient.getBlockNumber();
        const fromBlock = currentBlock > BigInt(40000) ? currentBlock - BigInt(40000) : BigInt(0);

        const logs = await publicClient.getLogs({
          address: ENTRY_POINT_ADDRESS as `0x${string}`,
          event: {
            type: 'event',
            name: 'UserOperationEvent',
            inputs: [
              { type: 'bytes32', name: 'userOpHash', indexed: true },
              { type: 'address', name: 'sender', indexed: true },
              { type: 'address', name: 'paymaster', indexed: true },
              { type: 'uint256', name: 'nonce', indexed: false },
              { type: 'bool', name: 'success', indexed: false },
              { type: 'uint256', name: 'actualGasCost', indexed: false },
              { type: 'uint256', name: 'actualGasUsed', indexed: false },
            ]
          },
          args: {
            sender: predictedVaultAddress as `0x${string}`,
          },
          fromBlock,
          toBlock: 'latest',
        });

        if (!mounted) return;

        let totalGas = BigInt(0);
        const parsedEvents = await Promise.all(logs.map(async (log: any) => {
          totalGas += log.args.actualGasCost || BigInt(0);
          
          const [block, receipt] = await Promise.all([
            publicClient.getBlock({ blockNumber: log.blockNumber }),
            publicClient.getTransactionReceipt({ hash: log.transactionHash })
          ]);

          let debtRepaidStr = "0.50 USDC"; // Fallback as requested
          try {
            // Find USDC Transfer event: Transfer(address indexed from, address indexed to, uint256 value)
            const USDC_ADDRESS = '0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8'.toLowerCase();
            const TRANSFER_SIGNATURE = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
            
            const usdcTransfer = receipt.logs.find(
              (rLog: any) => rLog.address?.toLowerCase() === USDC_ADDRESS && rLog.topics && rLog.topics[0] === TRANSFER_SIGNATURE
            );

            if (usdcTransfer && usdcTransfer.data && usdcTransfer.data !== '0x') {
              // The amount is the non-indexed data
              const amount = BigInt(usdcTransfer.data);
              debtRepaidStr = (Number(amount) / 1e6).toFixed(2) + " USDC";
            } else {
              console.log("No USDC Transfer log found in receipt for tx:", log.transactionHash);
            }
          } catch (e) {
            console.error("Failed to parse USDC transfer amount for tx:", log.transactionHash, e);
            // Fallback to the default rescue amount of 0.50 USDC
            debtRepaidStr = "0.50 USDC";
          }

          return {
            id: log.transactionHash,
            vault: { id: log.args.sender },
            gasCost: log.args.actualGasCost,
            debtRepaid: debtRepaidStr,
            timestamp: block.timestamp,
          };
        }));
        
        // Sort descending by timestamp
        parsedEvents.sort((a, b) => Number(b.timestamp) - Number(a.timestamp));

        setTotalGasSponsored(totalGas);
        setRecentEvents(parsedEvents);
      } catch (err) {
        console.error("Failed to fetch EntryPoint logs:", err);
      } finally {
        if (mounted && isInitial) setLogsLoading(false);
      }
    }

    fetchLogs(true);
    
    // Auto-refresh logs every 10 seconds
    const interval = setInterval(() => fetchLogs(false), 10000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [publicClient, predictedVaultAddress, isVaultDeployed]);

  if (!mounted) {
    return (
      <div className="min-h-screen bg-rose-50 text-slate-800 selection:bg-rose-500/30 p-8">
        <header className="flex justify-between items-center mb-8 border-b border-rose-100 pb-4">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-tr from-indigo-500 to-purple-500 flex items-center justify-center font-bold text-white shadow-lg shadow-indigo-500/20">S</div>
            <span className="text-xl font-bold bg-gradient-to-r from-rose-500 to-orange-400 bg-clip-text text-transparent">Sentinel-4337</span>
          </div>
          <button className="bg-rose-400 opacity-50 text-white font-medium px-5 py-2 rounded-xl cursor-not-allowed">
            Loading...
          </button>
        </header>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-rose-50 text-slate-800 selection:bg-rose-500/30">
      {/* Header */}
      <header className="border-b border-orange-100/50 bg-white/70 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-indigo-500 to-purple-500 flex items-center justify-center font-bold text-white text-lg shadow-lg shadow-purple-200">S</div>
            <span className="text-3xl font-extrabold bg-gradient-to-r from-rose-500 to-orange-400 bg-clip-text text-transparent">Sentinel-4337</span>
          </div>
          {isConnected ? (
            <button
              onClick={() => disconnect()}
              className="group flex items-center justify-center min-w-[160px] bg-white shadow-md shadow-rose-100 border border-transparent hover:border-rose-200 hover:shadow-rose-200 font-medium py-2.5 px-6 rounded-full transition-all duration-300"
            >
              <div className="w-2 h-2 rounded-full bg-emerald-500 mr-2 animate-pulse group-hover:hidden"></div>
              <span className="text-slate-700 group-hover:hidden tracking-wide">{address?.slice(0, 6)}...{address?.slice(-4)}</span>
              <span className="text-rose-500 hidden group-hover:flex items-center tracking-wide font-bold">
                <svg className="w-4 h-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                </svg>
                Disconnect
              </span>
            </button>
          ) : (
            <button
              onClick={handleConnect}
              className="bg-white hover:bg-rose-50 text-slate-700 border border-transparent hover:border-rose-200 shadow-md shadow-rose-100 font-medium py-2.5 px-6 rounded-full transition-all duration-300 active:scale-95 flex items-center gap-2"
            >
              <img src="https://upload.wikimedia.org/wikipedia/commons/3/36/MetaMask_Fox.svg" alt="MetaMask" className="w-5 h-5" />
              Connect MetaMask
            </button>
          )}
        </div>
      </header>

      {connectError && (
        <div className="max-w-7xl mx-auto mt-4 px-4 sm:px-6 lg:px-8">
          <div className="bg-red-900/40 border border-red-500/50 text-red-200 text-sm p-3 rounded-lg">
            {connectError.message}
          </div>
        </div>
      )}

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12 space-y-12">

        {/* Wrong Chain Warning */}
        {isWrongChain && (
          <div className="bg-amber-900/50 border border-amber-500 text-amber-200 p-4 rounded-xl text-sm flex items-center justify-between">
            <div>
              <p className="font-bold">⚠ Wrong Network</p>
              <p>Your wallet is on <strong>{chain?.name || `Chain ${chain?.id}`}</strong>. Please switch to <strong>Sepolia</strong> to interact with Sentinel.</p>
            </div>
            <button
              onClick={() => switchChainAsync({ chainId: sepolia.id })}
              className="ml-4 px-4 py-2 bg-amber-600 hover:bg-amber-500 text-white font-medium rounded-lg transition-all whitespace-nowrap"
            >
              Switch to Sepolia
            </button>
          </div>
        )}

        {/* Transaction Error Banner */}
        {(writeError || isTxError) && (
          <div className="bg-red-900/50 border border-red-500 text-red-200 p-4 rounded-xl text-sm font-mono">
            <p className="font-bold mb-1">⚠ Transaction Failed / Reverted:</p>
            <p className="break-all">{writeError?.message || txError?.message}</p>
          </div>
        )}

        {/* Hero Metrics */}
        <section className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="p-8 rounded-2xl bg-white shadow-xl shadow-rose-100/50 border border-rose-100 relative overflow-hidden group">
            <div className="absolute inset-0 bg-gradient-to-br from-rose-50 to-orange-50 opacity-0 group-hover:opacity-100 transition-opacity" />
            <p className="text-slate-500 text-sm font-medium mb-2 relative z-10">Total Value Protected</p>
            <p className="text-4xl font-bold text-slate-800 relative z-10">${totalValueProtectedDisplay}</p>
          </div>
          <div className="p-8 rounded-2xl bg-white shadow-xl shadow-rose-100/50 border border-rose-100 relative overflow-hidden group">
            <div className="absolute inset-0 bg-gradient-to-br from-emerald-50 to-teal-50 opacity-0 group-hover:opacity-100 transition-opacity" />
            <p className="text-slate-500 text-sm font-medium mb-2 relative z-10">Total Gas Sponsored</p>
            <p className="text-4xl font-bold text-slate-800 relative z-10">{(Number(totalGasSponsored) / 1e18).toFixed(4)} ETH</p>
          </div>
        </section>

        {/* User Vault Control */}
        <section className="p-8 rounded-3xl bg-white shadow-xl shadow-rose-100/50 border border-rose-100">
          <h2 className="text-2xl font-bold mb-6 text-slate-800">Vault Dashboard</h2>
          {!isConnected ? (
            <div className="text-center py-12">
              <p className="text-slate-500 mb-6">Connect your wallet to manage your Sentinel Vault.</p>
            </div>
          ) : isVaultDeployed ? (
            <div className="flex flex-col items-center justify-center p-8 bg-emerald-50 border border-emerald-200 rounded-xl">
              <h3 className="text-2xl font-bold text-emerald-600 mb-2">Vault Active</h3>
              <p className="text-slate-600">Your Sentinel Vault is deployed at:</p>
              <a
                href={`https://sepolia.etherscan.io/address/${predictedVaultAddress}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-orange-500 hover:underline font-mono mt-2"
              >
                {String(predictedVaultAddress)}
              </a>

              <div className="mt-8 w-full border-t border-emerald-200/50 pt-6 flex flex-col md:flex-row items-center justify-between gap-6">
                <div>
                  <p className="text-slate-500 mb-1">Aave Health Factor</p>
                  <div className="flex items-end gap-3">
                    <span className={`text-5xl font-black transition-colors duration-500 ${
                      healthFactorDisplay !== null && healthFactorDisplay !== "∞" && parseFloat(healthFactorDisplay) < 3.5
                        ? "text-red-500"
                        : "text-emerald-600"
                    }`}>
                      {healthFactorDisplay === null ? "—" : healthFactorDisplay}
                    </span>
                    <span className={`text-sm font-medium mb-2 transition-colors duration-500 ${
                      healthFactorDisplay !== null && healthFactorDisplay !== "∞" && parseFloat(healthFactorDisplay) < 3.5
                        ? "text-red-500/80"
                        : "text-emerald-600/80"
                    }`}>
                      {healthFactorDisplay !== null && healthFactorDisplay !== "∞" && parseFloat(healthFactorDisplay) < 3.5 ? "[AT RISK]" : "[SAFE]"}
                    </span>
                  </div>
                </div>
                <div className="flex flex-col items-center">
                  <button
                    onClick={handleApproveSessionKey}
                    className="px-8 py-3 bg-white hover:bg-rose-50 text-rose-600 border border-rose-200 font-medium rounded-xl transition-colors duration-300 shadow-sm active:scale-95 flex items-center gap-2"
                  >
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                    </svg>
                    Approve Session Key for Keeper Bot
                  </button>
                  <div className="mt-3 text-sm">
                    {isSessionActive ? (
                      <span className="text-emerald-600 font-medium flex items-center gap-1">
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        Session Key Active (Expires: {new Date(Number(sessionExpiry) * 1000).toLocaleDateString()})
                      </span>
                    ) : (
                      <span className="text-slate-400 font-medium flex items-center gap-1">
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                        </svg>
                        No Active Session Key
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="text-center py-12">
              <div className="w-16 h-16 mx-auto bg-rose-50 rounded-full flex items-center justify-center mb-6">
                <svg className="w-8 h-8 text-rose-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                </svg>
              </div>
              <h3 className="text-xl font-semibold mb-2 text-slate-800">No Vault Found</h3>
              <p className="text-slate-500 mb-8 max-w-md mx-auto">Deploy your smart account vault to start protecting your DeFi positions from liquidation.</p>
              <button
                onClick={handleDeploy}
                disabled={isDeploying}
                className="px-8 py-3 bg-rose-400 hover:bg-rose-500 disabled:bg-rose-300 disabled:opacity-50 text-white font-medium rounded-xl transition-all shadow-lg shadow-rose-200 active:scale-95 flex items-center justify-center mx-auto gap-2"
              >
                {isDeploying ? (
                  <>
                    <svg className="animate-spin -ml-1 mr-2 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    Deploying...
                  </>
                ) : isWrongChain ? (
                  "⚠ Switch to Sepolia First"
                ) : (
                  "Deploy Sentinel Vault"
                )}
              </button>
            </div>
          )}
        </section>

        {/* Transaction History Ledger */}
        <section>
          <div className="mb-6">
            <h3 className="text-xl font-bold flex items-center gap-3 text-slate-800">
              <div className="bg-rose-100 text-rose-500 rounded-lg p-2 flex items-center justify-center">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
              </div>
              Recent Rescues
            </h3>
            <p className="text-slate-500 text-sm mt-1 ml-11">Automated on-chain vault protection history</p>
          </div>
          <div className="overflow-x-auto rounded-2xl border border-orange-100/60 bg-white shadow-xl shadow-rose-100/40">
            <table className="w-full text-left text-sm">
              <thead className="bg-rose-50/40 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                <tr>
                  <th className="px-6 py-5">Tx Hash</th>
                  <th className="px-6 py-5">Vault</th>
                  <th className="px-6 py-5">Debt Repaid</th>
                  <th className="px-6 py-5">Gas Sponsored</th>
                  <th className="px-6 py-5">Time</th>
                </tr>
              </thead>
              <tbody>
                {logsLoading ? (
                  <tr>
                    <td colSpan={5} className="px-6 py-8 text-center text-slate-400">Loading ledger...</td>
                  </tr>
                ) : recentEvents.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-6 py-8 text-center text-slate-400">No rescue events found.</td>
                  </tr>
                ) : (
                  recentEvents.map((ev: any) => (
                    <tr key={ev.id} className="hover:bg-rose-50/30 transition-colors duration-200 border-b border-orange-50/50 last:border-b-0">
                      <td className="px-6 py-5 font-mono text-rose-500 font-medium">
                        <a href={`https://sepolia.etherscan.io/tx/${ev.id}`} target="_blank" rel="noopener noreferrer" className="hover:underline">
                          {ev.id.slice(0, 10)}...
                        </a>
                      </td>
                      <td className="px-6 py-5 font-mono text-slate-600 text-sm">{ev.vault.id.slice(0, 8)}...</td>
                      <td className="px-6 py-5">
                        <span className="bg-emerald-50 text-emerald-600 px-2.5 py-1 rounded-full text-xs font-medium">
                          {ev.debtRepaid}
                        </span>
                      </td>
                      <td className="px-6 py-5 text-slate-700 font-medium">{(Number(ev.gasCost) / 1e18).toFixed(4)} ETH</td>
                      <td className="px-6 py-5 text-slate-400 text-xs">{new Date(Number(ev.timestamp) * 1000).toLocaleString()}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}

