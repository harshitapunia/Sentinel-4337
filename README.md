<div align="center">

# 🛡️ Sentinel-4337: Autonomous DeFi Liquidation Protector

> *"Sleep peacefully knowing your DeFi positions are guarded 24/7."*

![Next.js](https://img.shields.io/badge/Next.js-black?style=for-the-badge&logo=next.js&logoColor=white)
![Solidity](https://img.shields.io/badge/Solidity-363636?style=for-the-badge&logo=solidity&logoColor=white)
![ERC-4337](https://img.shields.io/badge/ERC--4337-Account_Abstraction-blue?style=for-the-badge)
![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![Ethereum](https://img.shields.io/badge/Ethereum-3C3C3D?style=for-the-badge&logo=Ethereum&logoColor=white)

</div>

---

## 📖 The Problem & Solution

### The Threat ⚠️
Imagine this: you're asleep, away from your screen, or traveling. A sudden market crash triggers massive volatility, and your health factor on Aave plummets. Because you are using a standard Externally Owned Account (EOA), you cannot act in time. By the time you check your wallet, your position is **liquidated**—resulting in painful, unnecessary losses. 

> *Managing DeFi health factors manually is tedious, stressful, and impossible to monitor around the clock.*

### The Rescue 🦸‍♂️
Enter **Sentinel-4337**. We transform your vulnerable EOA setup into a fortified, smart contract-powered vault. Sentinel-4337 acts as a 24/7 background guardian, utilizing advanced **Account Abstraction (ERC-4337)** and automated keeper bots to monitor your Aave positions. The moment danger is detected, it automatically executes a rescue operation—without ever needing direct access to your primary private key. 

---

## ✨ Core Features & 🔮 Future Scope

### ✨ Core Features
*   🛡️ **Autonomous Liquidation Protection (Aave V3):** Automatically detects risky health factors and executes split-second rescue operations to save your collateral.
*   🧩 **Modular Account Abstraction (ERC-4337):** Upgrades your user experience by utilizing powerful Smart Accounts under the hood.
*   🔐 **Advanced Security via ERC-7579 Session Keys:** Our automated bot operates securely using restricted **Session Keys**. It can perform *only* necessary actions (like repaying debt or adding collateral) without exposing or controlling your main private key.
*   ⚡ **Fault-Tolerant Execution:** Features a Self-funded EntryPoint fallback mechanism, ensuring your rescue transactions are reliably executed even during adverse network conditions.
*   📊 **Real-Time Next.js Dashboard:** A sleek, intuitive, and highly responsive frontend where you can monitor your Vault's Total Value Protected, live Health Factor, and a log of recent rescue operations.

### 🔮 Future Scope 📈
*   🌐 **The Graph Protocol Integration:** We are actively planning the integration of Subgraphs for scalable, lightning-fast, and decentralized historical analytics querying directly on the frontend dashboard.

---

## ⚙️ Prerequisites

Before firing up Sentinel-4337 locally, ensure you have the following installed and ready:

*   **Node.js** (v18 or higher recommended)
*   **Web3 Wallet** (e.g., MetaMask)
*   **Sepolia Testnet ETH** (for deploying and executing test transactions)
*   **RPC URL** (Get a free one from [Alchemy](https://www.alchemy.com/) or [Infura](https://www.infura.io/))

---

## 🛠️ Local Setup & Installation

Get your local Sentinel up and running in minutes:

1. **Clone the repository:**
   ```bash
   git clone https://github.com/your-username/Sentinel-4337.git
   cd Sentinel-4337
   ```

2. **Install dependencies:**
   Navigate into the core and frontend directories to install the required packages:
   ```bash
   cd sentinel-4337-core
   npm install
   
   cd frontend
   npm install
   ```

3. **Configure Environment Variables:**
   We've provided an example file to make this easy. 
   ```bash
   # Inside the frontend directory
   cp .env.example .env.local
   ```
   > **Note:** Open your new `.env.local` file and plug in your RPC URL, private keys, and any other required configurations.

---

## 💻 Usage Guide: The Frontend vs. The Backend Engine

Sentinel-4337 operates elegantly across two synchronized, yet distinct environments. Here is how you use them:

### 🎨 The Frontend (UI)
This is your command center—a beautiful Next.js dashboard providing a visual representation of your protected assets.

*   **To start the UI:**
    ```bash
    cd sentinel-4337-core/frontend
    npm run dev
    ```
*   **What you see:** Open your browser to the local host address. From here, you can view your **Total Value Protected**, monitor your **Live Health Factor**, and audit the **history of automated rescue operations**.

### 🤖 The Keeper Bot (Terminal)
This is the off-chain automation engine—the vigilant Sentinel working tirelessly in the background.

*   **To start the Bot:**
    Open a *brand new terminal window*, ensure you are in the core directory (`sentinel-4337-core`), and run:
    ```bash
    npx tsx scripts/keeperBot.ts
    ```
*   **Why does it run in the terminal?** The Keeper Bot acts as an autonomous background server. It continuously polls the blockchain, keeping a watchful eye on your Aave health factor. When danger is detected, it independently constructs and submits the **ERC-7579 signed UserOp** to execute a rescue. No user intervention required!

---

## 🎬 The Demo Video (Why is it here?)

> While our codebase is fully functional and successfully deployed on the Sepolia testnet, we have included a pre-recorded screen capture for this evaluation.

**Why?** The demo video flawlessly captures the real-time syncing between the terminal bot execution (the rescue operation) and the subsequent frontend UI updates. Live testnets can suffer from unpredictable latency, delayed block times, or sudden RPC congestion. The video bypasses these uncontrollable variables, guaranteeing evaluators can witness the full end-to-end flow working perfectly during a time-constrained review process.