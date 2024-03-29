import { promises as fs } from "fs";

import { MetaTransaction } from "@gnosis.pm/safe-contracts";
import IERC20 from "@openzeppelin/contracts/build/contracts/IERC20Metadata.json";
import { expect } from "chai";
import { BigNumber, Contract, utils } from "ethers";
import { id } from "ethers/lib/utils";
import { task, types } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";

import {
  metadata,
  prepareRealAndVirtualDeploymentFromSafe,
  prepareVirtualDeploymentFromSafe,
  RealTokenDeployParams,
  VirtualTokenDeployParams,
  computeProofs,
  parseCsvFile,
} from "../ts";
import { defaultTokens } from "../ts/lib/constants";
import { contractsCreatedWithCreateCall } from "../ts/lib/safe";
import { removeSplitClaimFiles, splitClaimsAndSaveToFolder } from "../ts/split";

import {
  SupportedChainId,
  isChainIdSupported,
  deployWithOwners,
  CreateCallDeployment,
  MultiSendDeployment,
  execSafeTransaction,
  gnosisSafeAt,
} from "./ts/safe";
import {
  DeploymentInfo,
  OUTPUT_FOLDER,
  OutputParamsJsonFormat,
  PARAMS_FILE,
} from "./ts/test-deployment";

const defaultArgs = {
  userCount: 1000,
  totalSupply: BigNumber.from(10)
    .pow(3 * 3)
    .toString(),
  usdcPerCow: "0.15",
  usdcPerGno: "400",
  usdcPerWeth: "4000",
} as const;
interface DeployTaskArgs {
  claimCsv: string;
  totalSupply?: string;
  usdcToken?: string;
  usdcPerCow?: string;
  gnoToken?: string;
  usdcPerGno?: string;
  wethToken?: string;
  usdcPerWeth?: string;
  gnosisDao?: string;
  cowDao?: string;
  communityFundsTarget?: string;
  investorFundsTarget?: string;
  teamController?: string;
  cowToken?: string;
}
interface CleanArgs {
  claimCsv: string;
  totalSupply: BigNumber;
  usdc: Token;
  usdcPerCow: BigNumber;
  gno: Token;
  usdcPerGno: BigNumber;
  weth: Token;
  usdcPerWeth: BigNumber;
  chainId: SupportedChainId;
  gnosisDaoAddress: string | undefined;
  cowDaoAddress: string | undefined;
  communityFundsTargetAddress: string | undefined;
  investorFundsTargetAddress: string | undefined;
  teamControllerAddress: string | undefined;
  cowToken: string | undefined;
}

interface Token {
  decimals: number;
  instance: Contract;
}

interface MaybeDeterministicDeployment {
  address: string;
  transaction: MetaTransaction | null;
}
interface Deployment {
  transaction: MetaTransaction;
}

async function parseArgs(
  args: DeployTaskArgs,
  { ethers }: HardhatRuntimeEnvironment,
): Promise<CleanArgs> {
  const chainId = (await ethers.provider.getNetwork()).chainId.toString();

  if (!isChainIdSupported(chainId)) {
    throw new Error(`Chain id ${chainId} not supported by the Gnosis Safe`);
  }

  function defaultIfUnset<Key extends keyof typeof defaultTokens>(
    address: string | undefined,
    token: Key,
  ): string {
    const defaultByChainId: Record<string, string> = defaultTokens[token];
    if (
      address === undefined &&
      !Object.keys(defaultByChainId).includes(chainId)
    ) {
      throw new Error(
        `Chain id ${chainId} does not have a default address for ${token}`,
      );
    }
    const defaultAddress =
      defaultByChainId[chainId as keyof typeof defaultByChainId];
    return address ?? defaultAddress;
  }
  async function getToken(address: string): Promise<Token> {
    const instance = new Contract(address, IERC20.abi).connect(ethers.provider);
    const decimals = await instance.decimals();
    if (typeof decimals !== "number") {
      throw new Error(
        `Invalid number of decimals for token at address ${address}`,
      );
    }
    return {
      instance,
      decimals,
    };
  }
  const [usdc, gno, weth] = await Promise.all([
    getToken(defaultIfUnset(args.usdcToken, "usdc")),
    getToken(defaultIfUnset(args.gnoToken, "gno")),
    getToken(defaultIfUnset(args.wethToken, "weth")),
  ]);
  function checksummedAddress(address: string | undefined): string | undefined {
    return address === undefined ? undefined : utils.getAddress(address);
  }
  return {
    chainId,
    claimCsv: args.claimCsv,
    totalSupply: utils.parseUnits(
      args.totalSupply ?? defaultArgs.totalSupply,
      metadata.real.decimals,
    ),
    usdc,
    usdcPerCow: utils.parseUnits(
      args.usdcPerCow ?? defaultArgs.usdcPerCow,
      usdc.decimals,
    ),
    gno,
    usdcPerGno: utils.parseUnits(
      args.usdcPerGno ?? defaultArgs.usdcPerGno,
      usdc.decimals,
    ),
    weth,
    usdcPerWeth: utils.parseUnits(
      args.usdcPerWeth ?? defaultArgs.usdcPerWeth,
      usdc.decimals,
    ),
    gnosisDaoAddress: checksummedAddress(args.gnosisDao),
    cowDaoAddress: checksummedAddress(args.cowDao),
    communityFundsTargetAddress: checksummedAddress(args.communityFundsTarget),
    investorFundsTargetAddress: checksummedAddress(args.investorFundsTarget),
    teamControllerAddress: checksummedAddress(args.teamController),
    cowToken: checksummedAddress(args.cowToken),
  };
}

const setupTestDeploymentTask: () => void = () => {
  task(
    "test-deployment",
    "Generate a list of pseudorandom claims for each signer and deploy test contracts on the current network.",
  )
    .addPositionalParam(
      "claimCsv",
      "Path to the CSV file that contains the list of claims to generate.",
    )
    .addOptionalParam(
      "totalSupply",
      "The total supply of real token minted on deployment.",
      defaultArgs.totalSupply,
      types.string,
    )
    .addOptionalParam("usdcToken", "Address of token USDC.")
    .addOptionalParam("gnoToken", "Address of token GNO.")
    .addOptionalParam("wethToken", "Address of token WETH.")
    .addOptionalParam(
      "usdcPerCow",
      "How many USDC a COW is worth.",
      defaultArgs.usdcPerCow,
      types.string,
    )
    .addOptionalParam(
      "usdcPerGno",
      "How many USDC a GNO is worth.",
      defaultArgs.usdcPerGno,
      types.string,
    )
    .addOptionalParam(
      "usdcPerWeth",
      "How many USDC a WETH is worth.",
      defaultArgs.usdcPerWeth,
      types.string,
    )
    .addOptionalParam(
      "gnosisDao",
      "The address of the Gnosis Safe from which the contract will be deployed. If left out, a dedicated Gnosis Safe owned by the deployer will be deployed for this purpose.",
    )
    .addOptionalParam(
      "cowDao",
      "The address representing the Cow DAO. If left out, a dedicated Gnosis Safe owned by the deployer will be deployed for this purpose.",
    )
    .addOptionalParam(
      "communityFundsTarget",
      "The address that will receive the community funds. If left out, a dedicated Gnosis Safe owned by the deployer will be deployed for this purpose.",
    )
    .addOptionalParam(
      "investorFundsTarget",
      "The address that will receive the investor funds. If left out, a dedicated Gnosis Safe owned by the deployer will be deployed for this purpose.",
    )
    .addOptionalParam(
      "teamController",
      "The address that controls team claims. If left out, a dedicated Gnosis Safe owned by the deployer will be deployed for this purpose.",
    )
    .addOptionalParam(
      "cowToken",
      "The virtual token will point to this address for the cow token. If left out, the real token will be deployed by this script.",
    )
    .setAction(async (args, hre) => {
      await generateClaimsAndDeploy(await parseArgs(args, hre), hre);
    });
};

async function generateClaimsAndDeploy(
  {
    claimCsv,
    totalSupply,
    usdc,
    usdcPerCow,
    gno,
    usdcPerGno,
    weth,
    usdcPerWeth,
    chainId,
    gnosisDaoAddress,
    cowDaoAddress,
    communityFundsTargetAddress,
    investorFundsTargetAddress,
    teamControllerAddress,
    cowToken,
  }: CleanArgs,
  hre: HardhatRuntimeEnvironment,
) {
  const { ethers } = hre;
  const [deployer] = await ethers.getSigners();
  const salt = id(Date.now().toString());
  console.log(`Using deployer ${deployer.address}`);

  console.log("Reading user claims from file...");
  const claims = await parseCsvFile(claimCsv);

  console.log("Generating Merkle proofs...");
  const { merkleRoot, claims: claimsWithProof } = computeProofs(claims);

  // The contracts are deployed from a contract and require that some receiver
  // addresses are set. All these are created now and are Gnosis Safe.
  console.log("Setting up administration addresses...");
  const deploySafe: () => Promise<Contract> = async () =>
    (await deployWithOwners([deployer.address], 1, deployer, hre)).connect(
      ethers.provider,
    );
  const gnosisDao =
    gnosisDaoAddress === undefined
      ? await deploySafe()
      : gnosisSafeAt(gnosisDaoAddress).connect(deployer);
  // The remaining addresses don't need to be Gnosis Safes. We deploy Gnosis
  // Safes by default to make the deployment more similar to the expected final
  // deployment.
  const cowDao = cowDaoAddress ?? (await deploySafe()).address;
  const communityFundsTarget =
    communityFundsTargetAddress ?? (await deploySafe()).address;
  const investorFundsTarget =
    investorFundsTargetAddress ?? (await deploySafe()).address;
  const teamController = teamControllerAddress ?? (await deploySafe()).address;

  const realTokenDeployParams: RealTokenDeployParams = {
    initialTokenHolder: cowDao,
    totalSupply,
    cowDao,
  };

  const virtualTokenDeployParams: Omit<VirtualTokenDeployParams, "realToken"> =
    {
      merkleRoot,
      communityFundsTarget: communityFundsTarget,
      investorFundsTarget: investorFundsTarget,
      usdcToken: usdc.instance.address,
      usdcPrice: usdcPerCow,
      gnoToken: gno.instance.address,
      gnoPrice: utils
        .parseUnits("1", gno.decimals)
        .mul(usdcPerCow)
        .div(usdcPerGno),
      wrappedNativeToken: weth.instance.address,
      nativeTokenPrice: utils
        .parseUnits("1", weth.decimals)
        .mul(usdcPerCow)
        .div(usdcPerWeth),
      teamController: teamController,
    };

  console.log("Generating deploy transactions...");
  let realTokenDeployment: MaybeDeterministicDeployment;
  let virtualTokenDeployment: Deployment;
  if (cowToken === undefined) {
    const deployment = await prepareRealAndVirtualDeploymentFromSafe(
      realTokenDeployParams,
      virtualTokenDeployParams,
      MultiSendDeployment.networkAddresses[chainId],
      CreateCallDeployment.networkAddresses[chainId],
      ethers,
      salt,
    );
    realTokenDeployment = {
      address: deployment.realTokenAddress,
      transaction: deployment.realTokenDeployTransaction,
    };
    virtualTokenDeployment = {
      transaction: deployment.virtualTokenDeployTransaction,
    };
    expect(await ethers.provider.getCode(realTokenDeployment.address)).to.equal(
      "0x",
    );
  } else {
    {
      const deployment = await prepareVirtualDeploymentFromSafe(
        { ...virtualTokenDeployParams, realToken: cowToken },
        ethers,
        CreateCallDeployment.networkAddresses[chainId],
      );
      realTokenDeployment = { address: cowToken, transaction: null };
      virtualTokenDeployment = {
        transaction: deployment.virtualTokenDeployTransaction,
      };
    }
  }

  console.log("Clearing old files...");
  await fs.rm(`${OUTPUT_FOLDER}/claims.json`, { recursive: true, force: true });
  await fs.rm(`${OUTPUT_FOLDER}/${PARAMS_FILE}`, {
    recursive: true,
    force: true,
  });
  await removeSplitClaimFiles(OUTPUT_FOLDER);

  console.log("Saving generated data to file...");
  await fs.mkdir(OUTPUT_FOLDER, { recursive: true });
  await fs.writeFile(
    `${OUTPUT_FOLDER}/claims.json`,
    JSON.stringify(claimsWithProof),
  );
  await fs.writeFile(
    `${OUTPUT_FOLDER}/${PARAMS_FILE}`,
    deployParamsToString({
      realTokenDeployParams,
      virtualTokenDeployParams,
      realTokenAddress: realTokenDeployment.address,
    }),
  );
  await splitClaimsAndSaveToFolder(claimsWithProof, OUTPUT_FOLDER);

  if (realTokenDeployment.transaction !== null) {
    console.log("Deploying real token...");
    const deploymentReal = await execSafeTransaction(
      gnosisDao.connect(deployer),
      realTokenDeployment.transaction,
      [deployer],
    );
    await expect(deploymentReal).to.emit(
      gnosisDao.connect(ethers.provider),
      "ExecutionSuccess",
    );
    expect(
      await ethers.provider.getCode(realTokenDeployment.address),
    ).not.to.equal("0x");
  }

  console.log("Deploying virtual token...");
  const deploymentVirtual = await execSafeTransaction(
    gnosisDao.connect(deployer),
    virtualTokenDeployment.transaction,
    [deployer],
  );
  await expect(deploymentVirtual).to.emit(gnosisDao, "ExecutionSuccess");
  const createdContracts = await contractsCreatedWithCreateCall(
    deploymentVirtual,
    CreateCallDeployment.networkAddresses[chainId],
  );
  expect(createdContracts).to.have.length(1);
  const virtualTokenAddress = createdContracts[0];
  expect(await ethers.provider.getCode(virtualTokenAddress)).not.to.equal("0x");

  console.log("Updating files with deployment information...");
  await fs.writeFile(
    `${OUTPUT_FOLDER}/${PARAMS_FILE}`,
    deployParamsToString({
      realTokenDeployParams,
      virtualTokenDeployParams,
      realTokenAddress: realTokenDeployment.address,
      virtualTokenAddress,
    }),
  );
}

function deployParamsToString({
  realTokenDeployParams,
  virtualTokenDeployParams,
  realTokenAddress,
  virtualTokenAddress,
}: DeploymentInfo): string {
  const jsonContent: OutputParamsJsonFormat = {
    realTokenAddress,
    virtualTokenAddress,
    ...realTokenDeployParams,
    ...virtualTokenDeployParams,
  };
  return JSON.stringify(jsonContent, undefined, 2);
}

export { setupTestDeploymentTask };
