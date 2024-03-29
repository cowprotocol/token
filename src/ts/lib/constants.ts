import { utils } from "ethers";

export const defaultTokens = {
  usdc: {
    "1": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    "4": "0x4DBCdF9B62e891a7cec5A2568C3F4FAF9E8Abe2b",
    "5": "0xD87Ba7A50B2E7E660f678A895E4B72E7CB4CCd9C",
    "100": "0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83",
    "11155111": "0xbe72E441BF55620febc26715db68d3494213D8Cb",
  },
  weth: {
    // WETH / wXDAI
    "1": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
    "4": "0xc778417E063141139Fce010982780140Aa0cD5Ab", // WETH
    "5": "0xB4FBF271143F4FBf7B91A5ded31805e42b2208d6", // WETH
    "100": "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d", // wXDAI
    "11155111": "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14", // WETH
  },
  gno: {
    "1": "0x6810e776880C02933D47DB1b9fc05908e5386b96",
    "4": "0xd0Dab4E640D95E9E8A47545598c33e31bDb53C7c",
    "5": "0x02ABBDbAaa7b1BB64B5c878f7ac17f8DDa169532",
    "100": "0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb",
    "11155111": "0xd3f3d46FeBCD4CdAa2B83799b7A5CdcB69d135De",
  },
} as const;

export const realityModule = {
  // Note that this was added in the snapshot transaction that enabled the Reality module for the Gnosis DAO.
  // https://snapshot.org/#/gnosis.eth/proposal/QmNMRBnipvRfos9ze1MrKpFAsHqxhNrmxjrXzxJnhFif9b
  "1": "0x0ebac21f7f6a6599b5fa5f57baaa974adfec4613",
} as const;

// the amount of tokens to relay to the omni bridge at deployment time
export const amountToRelay = utils.parseEther("1");
