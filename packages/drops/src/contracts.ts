import { binToHex, cashAddressToLockingBytecode, hexToBin } from '@bitauth/libauth';
import { Contract, type Artifact, type NetworkProvider } from 'cashscript';
import shardArtifact from '../artifacts/DropsShard.json' with { type: 'json' };
import vaultArtifact from '../artifacts/DropsVault.json' with { type: 'json' };
import pendingArtifact from '../artifacts/DropsPending.json' with { type: 'json' };

export interface DropsConfig {
  receiptCategory: string; // display hex (txid order)
  pendingCategory: string; // display hex — root authority category
  rewardCategory: string; // display hex — FLDCH
  authorityPkh: string; // hex 20
  rootTimelock: number; // blocks
}

/** Token categories are displayed in txid order but introspected in VM (reversed) order. */
export const vmCategory = (displayHex: string) => binToHex(hexToBin(displayHex).reverse());

export function lockingBytecodeOf(address: string): string {
  const r = cashAddressToLockingBytecode(address);
  if (typeof r === 'string') throw new Error(r);
  return binToHex(r.bytecode);
}

export function dropsContracts(cfg: DropsConfig, provider: NetworkProvider) {
  const opts = { provider, contractType: 'p2sh32' as const };
  const vault = new Contract(vaultArtifact as unknown as Artifact, [hexToBin(vmCategory(cfg.receiptCategory))], opts);
  const pending = new Contract(
    pendingArtifact as unknown as Artifact,
    [BigInt(cfg.rootTimelock), hexToBin(vmCategory(cfg.receiptCategory)), hexToBin(cfg.authorityPkh)],
    opts,
  );
  const vaultBytecode = lockingBytecodeOf(vault.address);
  const pendingBytecode = lockingBytecodeOf(pending.address);
  const shard = new Contract(
    shardArtifact as unknown as Artifact,
    [
      hexToBin(vmCategory(cfg.receiptCategory)),
      hexToBin(vmCategory(cfg.pendingCategory)),
      hexToBin(vmCategory(cfg.rewardCategory)),
      hexToBin(vaultBytecode),
      hexToBin(pendingBytecode),
    ],
    opts,
  );
  return { shard, vault, pending, vaultBytecode, pendingBytecode, shardBytecode: lockingBytecodeOf(shard.address) };
}

export type DropsContracts = ReturnType<typeof dropsContracts>;
