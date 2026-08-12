export const FACTORY_ABI = [
  {
    inputs: [
      { internalType: "address", name: "owner", type: "address" },
      { internalType: "uint256", name: "salt", type: "uint256" }
    ],
    name: "createAccount",
    outputs: [{ internalType: "address", name: "ret", type: "address" }],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [
      { internalType: "address", name: "owner", type: "address" },
      { internalType: "uint256", name: "salt", type: "uint256" }
    ],
    name: "getAddress",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function"
  }
] as const;

export const VAULT_ABI = [
  {
    inputs: [
      { internalType: "address", name: "keeper", type: "address" },
      { internalType: "uint48", name: "validUntil", type: "uint48" }
    ],
    name: "registerSessionKey",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [{ internalType: "address", name: "", type: "address" }],
    name: "sessionKeys",
    outputs: [{ internalType: "uint48", name: "", type: "uint48" }],
    stateMutability: "view",
    type: "function",
  }
] as const;
