// The functions in this file are responsible for splitting the list of claims
// into multiple smaller files that are cheaper to load by the frontend.
//
// The code is similar to the code used for the same purpose by Uniswap:
// https://github.com/Uniswap/mrkl-drop-data-chunks/blob/c215bf1e4360205acdc6c154389b10a2f287974d/split.ts

import { promises as fs } from "fs";

import { ClaimType, ProvenClaim } from "./claim";

export type FirstAddress = string;
export type LastAddress = string;
export type AddressChunks = { [address: FirstAddress]: LastAddress };
export type ClaimChunk = Record<string, StringifiedProvenClaim[]>;
export type ClaimChunks = Record<FirstAddress, ClaimChunk>;

export interface StringifiedProvenClaim {
  type: string;
  amount: string;
  index: number;
  proof: string[];
}

export interface SplitClaims {
  addressChunks: AddressChunks;
  claimChunks: ClaimChunks;
}

/**
 * Splits the input claims into cohorts of approximatively the same byte size.
 * Each cohort is identified by the first (lexicographically sorted) address
 * in the cohort. A separate entry links the first address to the last address
 * of the cohort.
 *
 * @param claims The claims to split in distinct chuncks.
 * @param maxCohortSize The appriximate maximum size of a cohort in number of
 * users.
 */
export function splitClaims(
  claims: ProvenClaim[],
  desiredCohortSize = 70,
): SplitClaims {
  const sortedAddresses: string[] = claims
    .map(({ account }) => account)
    .filter(
      (account, i, thisArg) => thisArg.findIndex((a) => a === account) === i,
    );
  sortedAddresses.sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));

  const claimsByAddress: Record<string, StringifiedProvenClaim[]> = {};
  for (const user of sortedAddresses) {
    claimsByAddress[user] = claims
      .filter(({ account }) => account === user)
      .map((claim) => ({
        proof: claim.proof,
        index: claim.index,
        type: ClaimType[claim.type],
        amount: claim.claimableAmount.toString(),
      }));
  }

  const addressChunks: AddressChunks = {};
  const claimChunks: ClaimChunks = {};

  for (let i = 0; i < sortedAddresses.length; i += desiredCohortSize) {
    const lastIndex = Math.min(
      i + desiredCohortSize - 1,
      sortedAddresses.length - 1,
    );
    addressChunks[sortedAddresses[i]] = sortedAddresses[lastIndex];
    claimChunks[sortedAddresses[i]] = sortedAddresses
      .slice(i, lastIndex + 1)
      .reduce((claims, addr) => {
        claims[addr] = claimsByAddress[addr];
        return claims;
      }, <ClaimChunk>{});
  }

  return { claimChunks, addressChunks };
}

export async function splitClaimsAndSaveToFolder(
  claims: ProvenClaim[],
  path: string,
) {
  const { claimChunks, addressChunks } = splitClaims(claims);
  await fs.writeFile(`${path}/mapping.json`, JSON.stringify(addressChunks));
  const chunksDir = `${path}/chunks`;
  await fs.mkdir(chunksDir);
  for (const [firstAddress, chunk] of Object.entries(claimChunks)) {
    await fs.writeFile(
      `${chunksDir}/${firstAddress}.json`,
      JSON.stringify(chunk),
    );
  }
}

export async function removeSplitClaimFiles(path: string) {
  await fs.rm(`${path}/mapping.json`, { recursive: true, force: true });
  await fs.rm(`${path}/chunks`, { recursive: true, force: true });
}