import { TransactionResponse } from "@ethersproject/abstract-provider";
import { TypedDataSigner } from "@ethersproject/abstract-signer";
import {
  buildSafeTransaction,
  executeTxWithSigners,
  MetaTransaction,
} from "@gnosis.pm/safe-contracts";
import GnosisSafe from "@gnosis.pm/safe-contracts/build/artifacts/contracts/GnosisSafe.sol/GnosisSafe.json";
import CompatibilityFallbackHandlerDeployment from "@safe-global/safe-deployments/src/assets/v1.3.0/compatibility_fallback_handler.json";
import CreateCallDeployment from "@safe-global/safe-deployments/src/assets/v1.3.0/create_call.json";
import GnosisSafeDeployment from "@safe-global/safe-deployments/src/assets/v1.3.0/gnosis_safe.json";
import MultiSendDeployment from "@safe-global/safe-deployments/src/assets/v1.3.0/multi_send_call_only.json";
import GnosisSafeProxyFactoryDeployment from "@safe-global/safe-deployments/src/assets/v1.3.0/proxy_factory.json";
import { Contract, Signer, Wallet } from "ethers";
import { HardhatRuntimeEnvironment } from "hardhat/types";

import {
  createdProxies,
  prepareSafeWithOwners,
  SafeDeploymentAddresses,
} from "../../ts/lib/safe";

export { MultiSendDeployment, CreateCallDeployment };

export type SupportedChainId =
  keyof typeof GnosisSafeProxyFactoryDeployment.networkAddresses &
    keyof typeof GnosisSafeDeployment.networkAddresses &
    keyof typeof MultiSendDeployment.networkAddresses &
    keyof typeof CreateCallDeployment.networkAddresses &
    keyof typeof CompatibilityFallbackHandlerDeployment.networkAddresses;

export function isChainIdSupported(
  chainId: string,
): chainId is SupportedChainId {
  return (
    Object.keys(GnosisSafeProxyFactoryDeployment.networkAddresses).includes(
      chainId,
    ) &&
    Object.keys(GnosisSafeDeployment.networkAddresses).includes(chainId) &&
    Object.keys(MultiSendDeployment.networkAddresses).includes(chainId) &&
    Object.keys(CreateCallDeployment.networkAddresses).includes(chainId) &&
    Object.keys(
      CompatibilityFallbackHandlerDeployment.networkAddresses,
    ).includes(chainId)
  );
}

export function defaultSafeDeploymentAddresses(
  chainId: SupportedChainId,
): SafeDeploymentAddresses {
  return {
    factory: GnosisSafeProxyFactoryDeployment.networkAddresses[chainId],
    singleton: GnosisSafeDeployment.networkAddresses[chainId],
    fallbackHandler:
      CompatibilityFallbackHandlerDeployment.networkAddresses[chainId],
    createCall: CreateCallDeployment.networkAddresses[chainId],
    multisendCallOnly: MultiSendDeployment.networkAddresses[chainId],
  };
}

export async function execSafeTransaction(
  safe: Contract,
  transaction: MetaTransaction,
  signers: (Signer & TypedDataSigner)[],
): Promise<TransactionResponse> {
  const safeTransaction = buildSafeTransaction({
    ...transaction,
    nonce: await safe.nonce(),
  });

  // Hack: looking at the call stack of the imported function
  // `executeTxWithSigners`, it is enough that the signer's type is `Signer &
  // TypedDataSigner`. However, the Safe library function requires the signers'
  // type to be `Wallet`. We coerce the type to be able to use this function
  // with signers without reimplementing all execution and signing routines.
  return await executeTxWithSigners(safe, safeTransaction, signers as Wallet[]);
}

export async function deployWithOwners(
  owners: string[],
  threshold: number,
  deployer: Signer,
  { ethers }: HardhatRuntimeEnvironment,
): Promise<Contract> {
  const chainId = (await ethers.provider.getNetwork()).chainId.toString();
  if (!isChainIdSupported(chainId)) {
    throw new Error(`Chain id ${chainId} not supported by the Gnosis Safe`);
  }
  const safeDeploymentAddresses = defaultSafeDeploymentAddresses(chainId);
  const deployTransaction = await deployer.sendTransaction(
    await prepareSafeWithOwners(owners, threshold, safeDeploymentAddresses),
  );
  const proxies = await createdProxies(
    deployTransaction,
    safeDeploymentAddresses.factory,
  );
  if (proxies.length !== 1) {
    throw new Error(
      `Malformed deployment transaction, txhash ${deployTransaction.hash}`,
    );
  }

  const newSafeAddress = proxies[0];
  return new Contract(newSafeAddress, GnosisSafe.abi);
}

export function gnosisSafeAt(address: string): Contract {
  return new Contract(address, GnosisSafe.abi);
}
