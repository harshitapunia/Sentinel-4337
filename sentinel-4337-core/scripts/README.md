# Sentinel-4337 Keeper Bot (Phase 3)

The Sentinel Keeper Bot is a Node.js TypeScript daemon running 24/7. It continuously monitors the health factor of a specified Sentinel Vault on Aave V3. If the vault's health factor drops below a critical threshold (1.15), it instantly constructs and dispatches an ERC-4337 UserOperation via a Bundler to trigger an atomic flash loan rescue.

## Requirements
- Node.js >= 18
- npm or yarn

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure Environment:**
   Copy the `.env.example` file to `.env` and fill in the parameters:
   ```bash
   cp .env.example .env
   ```
   Provide your RPC and Bundler keys (e.g. Alchemy, Pimlico), your Vault Address, the Aave Pool Address, and the Keeper Bot's Session Key (Private Key).

## Running the Bot

You can run the bot directly using `ts-node`:

```bash
npx ts-node keeper.ts
```

The bot will ping the Aave Pool every 12 seconds (approximately one block time) to retrieve the vault's health factor.

- **[SAFE]**: Logs a heartbeat if health factor > 1.15.
- **[ALERT]**: If health factor falls below 1.15, the loop clears to prevent duplicate submissions, and the `executeRescue()` function is fired, crafting an ERC-7579 execution packed within an ERC-4337 v0.7 UserOperation.
