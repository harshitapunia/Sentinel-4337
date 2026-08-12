"use client";

import { useAccount, useConnect, useDisconnect, useReadContract, useWriteContract, useWaitForTransactionReceipt, useBlockNumber, useSwitchChain } from 'wagmi';
import { sepolia } from 'wagmi/chains';
import { injected } from 'wagmi/connectors';
import { FACTORY_ABI, VAULT_ABI } from '../config/abis';
import { useQuery } from '@apollo/client/react';
import { gql } from '@apollo/client/core';
import { useState, useEffect, useCallback } from 'react';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const SEPOLIA_RPC = 'https://ethereum-sepolia-rpc.publicnode.com';

const PROTOCOL_METRICS_QUERY = gql`
  query GetMetrics {
    vaults {
      id
      totalUsdSaved
      totalGasSubsidized
    }
    rescueEvents(first: 5, orderBy: timestamp, orderDirection: desc) {
      id
      vault {
        id
      }
      timestamp
      debtRepaid
      gasCost
    }
  }
`;

export default function Dashboard() {
  const [mounted, setMounted] = useState(false);
  const [isVaultDeployed, setIsVaultDeployed] = useState(false);
  const [codeCheckDone, setCodeCheckDone] = useState(false);

  const { isConnected, address, chain } = useAccount();
  const { connect, error: connectError } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChainAsync } = useSwitchChain();
  const { data, loading } = useQuery<any>(PROTOCOL_METRICS_QUERY);

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
  const healthFactor = "1.85";

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

  const KEEPER_BOT_ADDRESS = "0x9999999999999999999999999999999999999999";

  const { data: sessionExpiry } = useReadContract({
    address: predictedVaultAddress as `0x${string}`,
    abi: VAULT_ABI,
    functionName: 'sessionKeys',
    args: [KEEPER_BOT_ADDRESS],
    query: { enabled: isVaultDeployed },
  });

  const isSessionActive = !!sessionExpiry && Number(sessionExpiry) > Math.floor(Date.now() / 1000);

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

  // Derived metrics (safe fallback when subgraph is unavailable)
  const totalUsdSaved = data?.vaults ? data.vaults.reduce((acc: bigint, vault: any) => acc + BigInt(vault.totalUsdSaved), BigInt(0)) : BigInt(0);
  const totalGasSubsidized = data?.vaults ? data.vaults.reduce((acc: bigint, vault: any) => acc + BigInt(vault.totalGasSubsidized), BigInt(0)) : BigInt(0);
  const recentEvents = data?.rescueEvents || [];

  if (!mounted) {
    return (
      <div className="min-h-screen bg-gray-950 text-white selection:bg-indigo-500/30 p-8">
        <header className="flex justify-between items-center mb-8 border-b border-gray-800 pb-4">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-tr from-indigo-500 to-purple-500 flex items-center justify-center font-bold text-white shadow-lg shadow-indigo-500/20">S</div>
            <span className="text-xl font-bold bg-gradient-to-r from-white to-gray-400 bg-clip-text text-transparent">Sentinel-4337</span>
          </div>
          <button className="bg-indigo-600 opacity-50 text-white font-medium px-5 py-2 rounded-xl cursor-not-allowed">
            Loading...
          </button>
        </header>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 text-white selection:bg-indigo-500/30">
      {/* Header */}
      <header className="border-b border-gray-800 bg-gray-900/50 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-tr from-indigo-500 to-purple-500 flex items-center justify-center font-bold text-white shadow-lg shadow-indigo-500/20">S</div>
            <span className="text-xl font-bold bg-gradient-to-r from-white to-gray-400 bg-clip-text text-transparent">Sentinel-4337</span>
          </div>
          {isConnected ? (
            <button
              onClick={() => disconnect()}
              className="bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-400 border border-indigo-500/30 font-medium py-2 px-4 rounded-xl transition-all"
            >
              Disconnect {address?.slice(0, 6)}...{address?.slice(-4)}
            </button>
          ) : (
            <button
              onClick={handleConnect}
              className="bg-indigo-600 hover:bg-indigo-500 text-white font-medium py-2 px-5 rounded-xl transition-all shadow-lg shadow-indigo-500/25 active:scale-95 flex items-center gap-2"
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
          <div className="p-8 rounded-2xl bg-gray-900/50 border border-gray-800 relative overflow-hidden group">
            <div className="absolute inset-0 bg-gradient-to-br from-indigo-500/5 to-purple-500/5 opacity-0 group-hover:opacity-100 transition-opacity" />
            <p className="text-gray-400 text-sm font-medium mb-2">Total Value Protected</p>
            <p className="text-4xl font-bold text-white">${(Number(totalUsdSaved) / 1e18).toFixed(2)}</p>
          </div>
          <div className="p-8 rounded-2xl bg-gray-900/50 border border-gray-800 relative overflow-hidden group">
            <div className="absolute inset-0 bg-gradient-to-br from-emerald-500/5 to-teal-500/5 opacity-0 group-hover:opacity-100 transition-opacity" />
            <p className="text-gray-400 text-sm font-medium mb-2">Total Gas Sponsored</p>
            <p className="text-4xl font-bold text-white">{(Number(totalGasSubsidized) / 1e18).toFixed(4)} ETH</p>
          </div>
        </section>

        {/* User Vault Control */}
        <section className="p-8 rounded-3xl bg-gradient-to-b from-gray-800/50 to-gray-900/50 border border-gray-800">
          <h2 className="text-2xl font-bold mb-6">Vault Dashboard</h2>
          {!isConnected ? (
            <div className="text-center py-12">
              <p className="text-gray-400 mb-6">Connect your wallet to manage your Sentinel Vault.</p>
            </div>
          ) : isVaultDeployed ? (
            <div className="flex flex-col items-center justify-center p-8 bg-green-900/20 border border-green-500/50 rounded-xl">
              <h3 className="text-2xl font-bold text-green-400 mb-2">Vault Active</h3>
              <p className="text-slate-300">Your Sentinel Vault is deployed at:</p>
              <a
                href={`https://sepolia.etherscan.io/address/${predictedVaultAddress}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-400 hover:underline font-mono mt-2"
              >
                {String(predictedVaultAddress)}
              </a>

              <div className="mt-8 w-full border-t border-green-500/20 pt-6 flex flex-col md:flex-row items-center justify-between gap-6">
                <div>
                  <p className="text-gray-400 mb-1">Aave Health Factor</p>
                  <div className="flex items-end gap-3">
                    <span className="text-5xl font-black text-emerald-400">{healthFactor}</span>
                    <span className="text-emerald-400/70 text-sm font-medium mb-2">[SAFE]</span>
                  </div>
                </div>
                <div className="flex flex-col items-center">
                  <button
                    onClick={handleApproveSessionKey}
                    className="px-8 py-3 bg-white hover:bg-gray-100 text-gray-950 font-medium rounded-xl transition-all shadow-xl active:scale-95 flex items-center gap-2"
                  >
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                    </svg>
                    Approve Session Key for Keeper Bot
                  </button>
                  <div className="mt-3 text-sm">
                    {isSessionActive ? (
                      <span className="text-emerald-400 font-medium flex items-center gap-1">
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        Session Key Active (Expires: {new Date(Number(sessionExpiry) * 1000).toLocaleDateString()})
                      </span>
                    ) : (
                      <span className="text-gray-500 font-medium flex items-center gap-1">
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
              <div className="w-16 h-16 mx-auto bg-indigo-500/10 rounded-full flex items-center justify-center mb-6">
                <svg className="w-8 h-8 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                </svg>
              </div>
              <h3 className="text-xl font-semibold mb-2">No Vault Found</h3>
              <p className="text-gray-400 mb-8 max-w-md mx-auto">Deploy your smart account vault to start protecting your DeFi positions from liquidation.</p>
              <button
                onClick={handleDeploy}
                disabled={isDeploying}
                className="px-8 py-3 bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-800 disabled:opacity-50 text-white font-medium rounded-xl transition-all shadow-lg shadow-indigo-500/25 active:scale-95 flex items-center justify-center mx-auto gap-2"
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
          <h3 className="text-xl font-bold mb-6 flex items-center gap-2">
            <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            Recent Rescues
          </h3>
          <div className="overflow-x-auto rounded-xl border border-gray-800 bg-gray-900/30">
            <table className="w-full text-left text-sm">
              <thead className="bg-gray-800/50 text-gray-400">
                <tr>
                  <th className="px-6 py-4 font-medium">Tx Hash</th>
                  <th className="px-6 py-4 font-medium">Vault</th>
                  <th className="px-6 py-4 font-medium">Debt Repaid</th>
                  <th className="px-6 py-4 font-medium">Gas Sponsored</th>
                  <th className="px-6 py-4 font-medium">Time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {loading ? (
                  <tr>
                    <td colSpan={5} className="px-6 py-8 text-center text-gray-500">Loading ledger...</td>
                  </tr>
                ) : recentEvents.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-6 py-8 text-center text-gray-500">No rescue events found.</td>
                  </tr>
                ) : (
                  recentEvents.map((ev: any) => (
                    <tr key={ev.id} className="hover:bg-gray-800/20 transition-colors">
                      <td className="px-6 py-4 font-mono text-indigo-400">{ev.id.slice(0, 10)}...</td>
                      <td className="px-6 py-4 font-mono">{ev.vault.id.slice(0, 8)}...</td>
                      <td className="px-6 py-4 text-emerald-400">+${(Number(ev.debtRepaid) / 1e18).toFixed(2)}</td>
                      <td className="px-6 py-4 text-purple-400">{(Number(ev.gasCost) / 1e18).toFixed(4)} ETH</td>
                      <td className="px-6 py-4 text-gray-400">{new Date(Number(ev.timestamp) * 1000).toLocaleString()}</td>
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

