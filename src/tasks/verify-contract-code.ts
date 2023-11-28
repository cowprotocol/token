import { promises as fs } from "fs";

import type { HardhatEthersHelpers } from "@nomiclabs/hardhat-ethers/types";
import { task } from "hardhat/config";
import type { HardhatRuntimeEnvironment } from "hardhat/types";

import {
  constructorInput,
  ContractName,
  DeployParams,
  getDeployArgsFromRealToken,
  getDeployArgsFromVirtualToken,
  getDeployArgsFromBridgedTokenDeployer,
} from "../ts";

import {
  OUTPUT_FOLDER,
  OutputParamsJsonFormat,
  PARAMS_FILE,
} from "./ts/test-deployment";

interface Args {
  virtualToken?: string;
  forwarder?: string;
  bridgedTokenDeployer?: string;
  useTestDeploymentParams: boolean;
}

const setupVerifyContractCodeTask: () => void = () => {
  task(
    "verify-contract-code",
    "Verify the contract code on the network's block exporer.",
  )
    .addOptionalParam(
      "virtualToken",
      "The address of the deployed virtual vCOW token.",
    )
    .addFlag(
      "useTestDeploymentParams",
      "Test contract code of latest test deployment",
    )
    .addOptionalParam(
      "forwarder",
      "The address of the deployed forwarder contract.",
    )
    .addOptionalParam(
      "bridgedTokenDeployer",
      "The address of the deployed bridgedTokenDeployer contract.",
    )
    .setAction(verifyContractCode);
};
export { setupVerifyContractCodeTask };

async function verifyContractCode(
  {
    virtualToken,
    forwarder,
    bridgedTokenDeployer,
    useTestDeploymentParams,
  }: Args,
  hre: HardhatRuntimeEnvironment,
) {
  if (virtualToken !== undefined) {
    await verifyVirtualToken(virtualToken, hre);
  }

  if (forwarder !== undefined) {
    await verifyContract(ContractName.Forwarder, forwarder, hre);
  }
  if (bridgedTokenDeployer !== undefined) {
    await verifyContract(
      ContractName.BridgedTokenDeployer,
      bridgedTokenDeployer,
      hre,
    );
  }

  if (useTestDeploymentParams === true) {
    const testDeploymentParams: OutputParamsJsonFormat = JSON.parse(
      await fs.readFile(`${OUTPUT_FOLDER}/${PARAMS_FILE}`, "utf8"),
    );
    if (testDeploymentParams.virtualTokenAddress === undefined) {
      throw new Error(
        "Virtual token address is not defined in test deployment params",
      );
    }
    const realTokenDeploymentParams: DeployParams[ContractName.RealToken] = {
      initialTokenHolder: testDeploymentParams.initialTokenHolder,
      cowDao: testDeploymentParams.cowDao,
      totalSupply: testDeploymentParams.totalSupply,
    };
    await verifyVirtualToken(
      testDeploymentParams.virtualTokenAddress,
      hre,
      realTokenDeploymentParams,
    );
  }
}

async function verifyVirtualToken(
  virtualTokenAddress: string,
  hre: HardhatRuntimeEnvironment,
  realTokenDeployArgsOverride?: DeployParams[ContractName.RealToken],
) {
  // Check that the contract is indeed the virtual token and not another token
  // (as for example the real token).
  const virtualToken = (
    await hre.ethers.getContractFactory(ContractName.VirtualToken)
  )
    .attach(virtualTokenAddress)
    .connect(hre.ethers.provider);
  try {
    const tokenSymbol = await virtualToken.symbol();
    if (tokenSymbol !== "vCOW") {
      throw new Error(
        `The address to verify has a token with symbol ${tokenSymbol}. Expected to verify token vCOW. Please use the address of the virtual COW token instead.`,
      );
    }
  } catch (error) {
    console.error(error);
    throw new Error(
      "Failed to verify token contract code. The input address is not the vCOW token.",
    );
  }

  await verifyContract(ContractName.VirtualToken, virtualToken.address, hre);

  const realTokenAddress = await virtualToken.cowToken();
  await verifyContract(
    ContractName.RealToken,
    realTokenAddress,
    hre,
    realTokenDeployArgsOverride,
  );
}

async function verifyContract(
  name: ContractName,
  address: string,
  hre: HardhatRuntimeEnvironment & { ethers: HardhatEthersHelpers },
  deployArgsOverride?: DeployParams[ContractName],
) {
  console.log(`Verifying contract ${name} at address ${address}`);
  const contract = (await hre.ethers.getContractFactory(name))
    .attach(address)
    .connect(hre.ethers.provider);

  let deployArgs: DeployParams[ContractName];
  if (deployArgsOverride === undefined) {
    switch (name) {
      case ContractName.RealToken: {
        deployArgs = await getDeployArgsFromRealToken(contract);
        break;
      }
      case ContractName.VirtualToken: {
        deployArgs = await getDeployArgsFromVirtualToken(contract);
        break;
      }
      case ContractName.Forwarder: {
        deployArgs = {};
        break;
      }
      case ContractName.BridgedTokenDeployer: {
        deployArgs = await getDeployArgsFromBridgedTokenDeployer(contract);
        break;
      }
      default: {
        throw new Error(
          `Contract verification for ${name} is currently not implemented`,
        );
      }
    }
  } else {
    deployArgs = deployArgsOverride;
  }

  // Note: no need to specify which contract to verify as the plugin detects
  // the right contract automatically.
  // https://hardhat.org/plugins/nomiclabs-hardhat-etherscan.html#how-it-works
  await hre.run("verify:verify", {
    address: contract.address,
    constructorArguments: constructorInput(name, deployArgs),
  });
}
