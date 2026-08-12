import { BigInt } from '@graphprotocol/graph-ts';
import { LiquidationPrevented } from '../generated/SentinelVault/SentinelVault';
import { Vault, RescueEvent } from '../generated/schema';

export function handleLiquidationPrevented(event: LiquidationPrevented): void {
  // Create a new RescueEvent entity using the transaction hash as the ID
  let rescueEvent = new RescueEvent(event.transaction.hash);
  rescueEvent.vault = event.params.vault;
  rescueEvent.timestamp = event.block.timestamp;
  rescueEvent.debtRepaid = event.params.debtRepaid;
  rescueEvent.gasCost = event.params.gasCost;
  
  // Load the Vault entity using the vault address
  let vault = Vault.load(event.params.vault);
  
  // If the Vault doesn't exist yet, initialize it
  if (vault == null) {
    vault = new Vault(event.params.vault);
    vault.totalUsdSaved = BigInt.fromI32(0);
    vault.totalGasSubsidized = BigInt.fromI32(0);
  }
  
  // Add the newly saved amounts to the vault totals
  vault.totalUsdSaved = vault.totalUsdSaved.plus(event.params.debtRepaid);
  vault.totalGasSubsidized = vault.totalGasSubsidized.plus(event.params.gasCost);
  
  // Save both entities to the store
  rescueEvent.save();
  vault.save();
}
