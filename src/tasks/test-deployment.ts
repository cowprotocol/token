import { promises as fs } from "fs";

import IERC20 from "@openzeppelin/contracts/build/contracts/IERC20Metadata.json";
import { expect } from "chai";
import { BigNumber, Contract, utils, Wallet } from "ethers";
import { id } from "ethers/lib/utils";
import { task, types } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";

import {
  metadata,
  prepareSafeDeployment,
  RealTokenDeployParams,
  VirtualTokenDeployParams,
  Claim,
  ClaimType,
  allClaimTypes,
  computeProofs,
} from "../ts";
import { removeSplitClaimFiles, splitClaimsAndSaveToFolder } from "../ts/split";

import {
  SupportedChainId,
  isChainIdSupported,
  deployWithOwners,
  MultiSendDeployment,
  execSafeTransaction,
} from "./ts/safe";

const OUTPUT_FOLDER = "./output";

const defaultTokens = {
  usdc: {
    "4": "0x4DBCdF9B62e891a7cec5A2568C3F4FAF9E8Abe2b",
  },
  weth: {
    "4": "0xc778417E063141139Fce010982780140Aa0cD5Ab",
  },
  gno: {
    "4": "0xd0Dab4E640D95E9E8A47545598c33e31bDb53C7c",
  },
} as const;

const defaultArgs = {
  userCount: 1000,
  totalSupply: (10n ** (3n * 4n)).toString(),
  usdcPerCow: "0.15",
  usdcPerGno: "400",
  usdcPerWeth: "4000",
} as const;
interface DeployTaskArgs {
  mnemonic: string;
  userCount?: number;
  totalSupply?: string;
  usdcToken?: string;
  usdcPerCow?: string;
  gnoToken?: string;
  usdcPerGno?: string;
  wethToken?: string;
  usdcPerWeth?: string;
}
interface CleanArgs {
  mnemonic: string;
  userCount: number;
  totalSupply: BigNumber;
  usdc: Token;
  usdcPerCow: BigNumber;
  gno: Token;
  usdcPerGno: BigNumber;
  weth: Token;
  usdcPerWeth: BigNumber;
  chainId: SupportedChainId;
}

interface Token {
  decimals: number;
  instance: Contract;
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
  return {
    chainId,
    mnemonic: args.mnemonic,
    userCount: args.userCount ?? defaultArgs.userCount,
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
  };
}

const setupTestDeploymentTask: () => void = () => {
  task(
    "test-deployment",
    "Generate a list of pseudorandom claims for each signer and deploy test contracts on the current network.",
  )
    .addParam("mnemonic", "The mnemonic used to generate user addresses.")
    .addOptionalParam(
      "userCount",
      "Random claims will be generated for this amount of users. Their secret key will be generated from the mnemonic.",
      defaultArgs.userCount,
      types.int,
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
    .setAction(async (args, hre) => {
      await generateClaimsAndDeploy(await parseArgs(args, hre), hre);
    });
};

function powerSet<T>(set: Set<T>): Set<Set<T>> {
  const values = [...set.values()];
  const result: Set<Set<T>> = new Set();
  for (let i = 0; i < 2 ** values.length; i++) {
    result.add(new Set(values.filter((_, pos) => (i & (1 << pos)) !== 0)));
  }
  return result;
}

function generateClaims(users: string[]): Claim[] {
  // For every possible configuration of claims, there should be a user with
  // these claims. An example of claim configuration is a user who has three
  // claims: Investor, UserOption, and Airdrop.

  // We filter out impossible configuration, that is a team claim with any other
  // vesting claim. Also, we don't need users without claims.
  const vestingClaimTypes = [
    ClaimType.GnoOption,
    ClaimType.UserOption,
    ClaimType.Investor,
  ];
  const admissibleClaimConfigurations = [...powerSet(new Set(allClaimTypes))]
    .filter(
      (configuration) =>
        !(
          configuration.has(ClaimType.Team) &&
          vestingClaimTypes.some((type) => configuration.has(type))
        ),
    )
    .filter((configuration) => configuration.size !== 0);

  const pseudorandomAmount = (i: number) =>
    BigNumber.from(id(i.toString()))
      .mod(10000)
      .mul(utils.parseUnits("1", metadata.real.decimals));
  return users
    .map((account, i) =>
      Array.from(
        admissibleClaimConfigurations[i % admissibleClaimConfigurations.length],
      ).map((type) => ({
        account,
        claimableAmount: pseudorandomAmount(i),
        type,
      })),
    )
    .flat();
}

async function generateClaimsAndDeploy(
  {
    mnemonic,
    userCount,
    totalSupply,
    usdc,
    usdcPerCow,
    gno,
    usdcPerGno,
    weth,
    usdcPerWeth,
    chainId,
  }: CleanArgs,
  hre: HardhatRuntimeEnvironment,
) {
  const { ethers } = hre;
  const [deployer] = await ethers.getSigners();
  const salt = id(Date.now().toString());
  console.log(`Using deployer ${deployer.address}`);

  console.log("Generating user PKs...");
  const users = Array(userCount)
    .fill(null)
    .map((_, i) => {
      process.stdout.cursorTo(0);
      process.stdout.write(`${Math.floor((i * 100) / userCount)}%`);
      return Wallet.fromMnemonic(mnemonic, `m/44'/60'/${i}'/0/0`);
    });
  process.stdout.cursorTo(0);
  const privateKeys: Record<string, string> = {};
  for (const user of users) {
    privateKeys[user.address] = user.privateKey;
  }

  console.log("Generating user claims...");
  const claims = generateClaims(users.map((user) => user.address));

  console.log("Generating Merkle proofs...");
  const { merkleRoot, claims: claimsWithProof } = computeProofs(claims);

  // The contracts are deployed from a contract and require that some receiver
  // addresses are set. All these are created now and are Gnosis Safe.
  console.log("Deploying administration safes...");
  const deploySafe: () => Promise<Contract> = async () =>
    (await deployWithOwners([deployer.address], 1, deployer, hre)).connect(
      ethers.provider,
    );
  const gnosisDao = await deploySafe();
  const cowDao = await deploySafe();
  const communityFundsTarget = await deploySafe();
  const investorFundsTarget = await deploySafe();
  const teamController = await deploySafe();

  const realTokenDeployParams: RealTokenDeployParams = {
    totalSupply,
    cowDao: cowDao.address,
  };

  const virtualTokenDeployParams: Omit<VirtualTokenDeployParams, "realToken"> =
    {
      merkleRoot,
      communityFundsTarget: communityFundsTarget.address,
      investorFundsTarget: investorFundsTarget.address,
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
      teamController: teamController.address,
    };

  console.log("Generating deploy transactions...");
  const {
    realTokenDeployTransaction,
    virtualTokenDeployTransaction,
    realTokenAddress,
    virtualTokenAddress,
  } = await prepareSafeDeployment(
    realTokenDeployParams,
    virtualTokenDeployParams,
    MultiSendDeployment.networkAddresses[chainId],
    ethers,
    salt,
  );

  expect(await ethers.provider.getCode(realTokenAddress)).to.equal("0x");
  expect(await ethers.provider.getCode(virtualTokenAddress)).to.equal("0x");

  console.log("Clearing old files");
  await fs.rm(`${OUTPUT_FOLDER}/private-keys.json`, {
    recursive: true,
    force: true,
  });
  await fs.rm(`${OUTPUT_FOLDER}/claims.json`, { recursive: true, force: true });
  await fs.rm(`${OUTPUT_FOLDER}/params.json`, { recursive: true, force: true });
  await removeSplitClaimFiles(OUTPUT_FOLDER);

  console.log("Saving generated data to file...");
  await fs.mkdir(OUTPUT_FOLDER, { recursive: true });
  await fs.writeFile(
    `${OUTPUT_FOLDER}/private-keys.json`,
    JSON.stringify(privateKeys),
  );
  await fs.writeFile(
    `${OUTPUT_FOLDER}/claims.json`,
    JSON.stringify(claimsWithProof),
  );
  await fs.writeFile(
    `${OUTPUT_FOLDER}/params.json`,
    JSON.stringify({
      realTokenAddress,
      virtualTokenAddress,
      ...realTokenDeployParams,
      ...virtualTokenDeployParams,
    }),
  );
  await splitClaimsAndSaveToFolder(claimsWithProof, OUTPUT_FOLDER);

  console.log("Deploying real token...");
  const deploymentReal = await execSafeTransaction(
    gnosisDao.connect(deployer),
    realTokenDeployTransaction,
    [deployer],
  );
  await expect(deploymentReal).to.emit(
    gnosisDao.connect(ethers.provider),
    "ExecutionSuccess",
  );
  expect(await ethers.provider.getCode(realTokenAddress)).not.to.equal("0x");

  console.log("Deploying virtual token...");
  const deploymentVirtual = await execSafeTransaction(
    gnosisDao.connect(deployer),
    virtualTokenDeployTransaction,
    [deployer],
  );
  await expect(deploymentVirtual).to.emit(gnosisDao, "ExecutionSuccess");
  expect(await ethers.provider.getCode(virtualTokenAddress)).not.to.equal("0x");
}

export { setupTestDeploymentTask };