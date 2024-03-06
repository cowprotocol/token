import { promises as fs } from "fs";

import IERC20 from "@openzeppelin/contracts/build/contracts/IERC20Metadata.json";
import { BigNumber, constants, Contract, utils } from "ethers";
import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";

import {
  computeProofs,
  parseCsvFile,
  ClaimType,
  ExecutableClaim,
  getClaimManyInput,
  ProvenClaim,
} from "../ts";
import { defaultTokens } from "../ts/lib/constants";

import { SupportedChainId, isChainIdSupported } from "./ts/safe";

interface TaskArgs {
  claimCsv: string;
  usdcToken?: string;
  gnoToken?: string;
  wethToken?: string;
  payUsdc: boolean;
  payGno: boolean;
  payWeth: boolean;
  vCowToken: string;
  claimTargets: string;
}
interface CleanArgs {
  claimCsv: string;
  chainId: SupportedChainId;
  paymentTokens: PaymentTokens;
  vCowToken: Contract;
  claimTargets: string[];
}

interface Token {
  decimals: number;
  symbol: string;
  instance: Contract;
}
type PaymentTokens = Partial<Record<"usdc" | "gno" | "weth", Token>>;

async function parseArgs(
  args: TaskArgs,
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
  const paymentTokens: PaymentTokens = {};
  for (const [label, flag, address] of [
    ["usdc", args.payUsdc, args.usdcToken],
    ["gno", args.payGno, args.gnoToken],
    ["weth", args.payWeth, args.wethToken],
  ] as const) {
    if (flag) {
      const instance = new Contract(
        defaultIfUnset(args.usdcToken, label),
        IERC20.abi,
      ).connect(ethers.provider);
      const [decimals, symbol] = await Promise.all([
        instance.decimals(),
        instance.symbol(),
      ]);
      if (typeof decimals !== "number") {
        throw new Error(
          `Invalid number of decimals for token at address ${address}`,
        );
      }
      paymentTokens[label] = {
        instance,
        decimals,
        symbol,
      };
    }
  }

  const claimTargets = (await fs.readFile(args.claimTargets, "utf8"))
    .trim()
    .split("\n")
    .map(utils.getAddress);

  return {
    chainId,
    claimCsv: args.claimCsv,
    paymentTokens,
    vCowToken: await ethers.getContractAt(
      "CowProtocolVirtualToken",
      utils.getAddress(args.vCowToken),
    ),
    claimTargets,
  };
}

const setupMassClaimTask: () => void = () => {
  task(
    "mass-claim",
    "Generate a list of pseudorandom claims for each signer and deploy test contracts on the current network.",
  )
    .addParam(
      "claimCsv",
      "Path to the CSV file that contains the list of claims to generate.",
    )
    .addParam(
      "claimTargets",
      "Path to file of newline-separated addresses. This scripts claims vCOW for the addresses from this list",
    )
    .addOptionalParam("usdcToken", "Address of token USDC.")
    .addOptionalParam("gnoToken", "Address of token GNO.")
    .addOptionalParam("wethToken", "Address of token WETH.")
    .addFlag("payUsdc", "Pay for claims that require USDC")
    .addFlag("payGno", "Pay for claims that require GNO")
    .addFlag("payWeth", "Pay for claims that require WETH")
    .addParam(
      "vCowToken",
      "The virtual token will point to this address for the cow token.",
    )
    .setAction(async (args, hre) => {
      await massClaim(await parseArgs(args, hre), hre);
    });
};

async function massClaim(
  { claimCsv, paymentTokens, vCowToken, claimTargets }: CleanArgs,
  hre: HardhatRuntimeEnvironment,
) {
  const { ethers } = hre;
  const [payer] = await ethers.getSigners();
  console.log(
    `Paying claims and transaction fees from address ${payer.address}`,
  );

  console.log("Reading user claims from file...");
  const claims = await parseCsvFile(claimCsv);

  console.log("Generating Merkle proofs...");
  let { claims: claimsWithProof } = computeProofs(claims);

  console.log(`Batching claims for ${claimTargets.length} addresses...`);

  for (const token of Object.values(paymentTokens)) {
    if (
      BigNumber.from(
        await token.instance.allowance(payer.address, vCowToken.address),
      ).isZero()
    ) {
      console.log(`Approving token ${token.symbol}...`);
      const approvalTx = await token.instance
        .connect(payer)
        .approve(vCowToken.address, constants.MaxUint256);
      await approvalTx.wait();
    }
  }

  // Filter out claims for tokens we are not paying with.
  const skippedClaims: ClaimType[] = (
    [
      ["usdc", ClaimType.Investor],
      ["gno", ClaimType.GnoOption],
      ["weth", ClaimType.UserOption],
    ] as const
  )
    .filter(([label]) => !Object.keys(paymentTokens).includes(label))
    .map(([, type]) => type);
  claimsWithProof = claimsWithProof.filter(
    (claim) => !skippedClaims.includes(claim.type),
  );

  if (claimTargets !== null) {
    claimsWithProof = claimsWithProof.filter((claim) =>
      claimTargets.includes(utils.getAddress(claim.account)),
    );
  }

  const MAX_CLAIMS_IN_BATCH = 20; // about 1M-2M gas
  let countClaimed = 0;
  let claimSummary: string[] = [];
  while (countClaimed !== claimTargets.length && claimsWithProof.length !== 0) {
    const batchSize = Math.min(
      claimTargets.length - countClaimed,
      MAX_CLAIMS_IN_BATCH,
    );

    let taken;
    ({ taken, remaining: claimsWithProof } = await takeOpenClaims(
      batchSize,
      claimsWithProof,
      vCowToken,
    ));

    countClaimed += batchSize;
    console.log(`Claiming batch of size ${batchSize}...`);
    claimSummary = claimSummary.concat(
      taken.map((claim) => `${claim.account} (claim type ${claim.type})`),
    );

    const tx = await vCowToken
      .connect(payer)
      .claimMany(...getClaimManyInput(taken.map(fullyExecuteClaim)));
    await tx.wait();
    console.log(`Tx id: ${tx.hash}`);
  }
  console.log("Claimed for the following accounts:");
  for (const account of claimSummary) {
    console.log(account);
  }
}

async function takeOpenClaims(
  amount: number,
  claims: ProvenClaim[],
  vCowToken: Contract,
): Promise<{ taken: ProvenClaim[]; remaining: ProvenClaim[] }> {
  const MAX_BATCH_SIZE = 20;
  const taken: ProvenClaim[] = [];
  do {
    const areClaimed: boolean[] = await Promise.all(
      claims
        .slice(0, MAX_BATCH_SIZE)
        .map(({ index }) => vCowToken.isClaimed(index)),
    );
    for (const isClaimed of areClaimed) {
      if (!isClaimed) {
        taken.push(claims[0]);
      }
      claims = claims.slice(1);
      if (taken.length === amount) {
        return { taken, remaining: claims };
      }
    }
  } while (claims.length !== 0);
  return { taken, remaining: claims };
}

function fullyExecuteClaim(claim: ProvenClaim): ExecutableClaim {
  return {
    ...claim,
    claimedAmount: claim.claimableAmount,
  };
}

export { setupMassClaimTask };
