# CoW Protocol Token

This repository contains the Solidity smart contract code for the CoW Protocol/CowSwap token.

## Overview

This repo contains all code related to the deployment of the COW token contract and the tools that manage how the token will be distributed.

Two contracts will be deployed onchain: the CoW Protocol token contract (COW) and a "virtual" CoW Protocol token (vCOW).
The COW token is a standard ERC20 token that can optionally be minted by the CowDao, up to 3% of the total supply each year.
The virtual token manages how the real token is distributed and cannot be transferred.

In the deployment transaction, all existing COW tokens are minted and sent to the CoW Protocol DAO.
Shares of virtual tokens will be assigned to the users in advance based on a Merkle tree that is determined at deployment time.
Some claims will be paid (with different currencies), some will be vesting in time, and some will be cancellable.
All claims have a deadline, the latest is six weeks after deployment; no claim can be redeemed after its deadline has passed.
Claims can be exercised by anyone, but only the claim owner can partially redeem them.

After all shares of virtual token have been distributed, they may be made convertible to COW tokens by the CowDao.
To do this, the DAO would have to send to the virtual token contract the exact amount of COW tokens needed to cover all exercised virtual token claims.
Then, the claim owner will be able to swap virtual tokens to real tokens, effectively converting virtual tokens to real tokens one to one.

## Getting Started

### Building

```sh
yarn
yarn build
```

### Running Tests

```sh
yarn test
```

#### Test Coverage

The contracts code in this repo is fully covered by unit tests.
Test coverage can be checked by running the following command:

```sh
yarn coverage
```

A summary of coverage results are printed out to console. More detailed information is presented in the generated file `coverage/index.html`.

Contracts that are either vendored from other repositories or only used in tests are not included in coverage.

#### Gas Reporter

Gas consumption can be estimated from the tests. Setting the `REPORT_GAS` flag when running tests shows details on the gas consumption of each method.

```sh
REPORT_GAS=1 yarn test
```

### Contract Code Size

Contract code size can be benched by running:

```sh
yarn bench:code-size
```

### Deploying Contracts: Proposal-Transactions Creation

The contracts are deployed by the Gnosis DAO using the Zodiac module. 
In the following, it is show on to build the tx proposed to the Gnosis DAO with a script.

The deployment happens on two chains: Ethereum-Chain and Gnosis-Chain. 
At first, a deployment helper contract - called BridgedTokenDeployer - is deployed on Gnosis-Chain. 
This BridgedTokenDeployer contains the information to run the CowProtocolVirtualToken deployment on Gnosis-Chain. 
This contract will later be triggered from the Ethereum-Chain via the Omni-Bridge. 
The main part of the deployment is done on Ethereum-Chain. 
The GnosisDAO will initiate all necessary transactions to create the different safes, create the CowProtocolToken and CowProtocolVirtualToken. 
Furthermore, the GnosisDAO will bridge one CowProtocolToken to the Omni-Bridge in order to trigger the bridge to deploy the bridged CowProtocolToken also on Gnosis-Chain. 
Last, but not least, the GnosisDao will bridge two transactions to Gnosis Chain over the Omni-Bridge: the deployment of the Cow DAO (at the same address as in mainnet) and the trigger transaction to the BridgedTokenDeployer that deploys the CowProtocolVirtualToken.

The deployment has the following inputs:
- mainnet/claims.csv file with the airdrop information for mainnet. See [example](#example-csv-file-with-claims)
- setting.json describing the most important parameters. See [example](example/gip-cow-deployment-settings.json)
- gnosischain/claims.csv file with the airdrop information for Gnosis-Chain

And two .env files should be prepared for each network:
- example/gnosischain/.env file for gnosis chain. See [example](example/gnosischain/env.sample)
- example/mainnet/.env file for Ethereum-Chain. See [example](example/mainnet/env.sample)

#### 1st step: Deployment on Gnosis-Chain

```
yarn build
source example/gnosischain/.env
npx hardhat deployment-bridged-token-deployer --settings ./settings.json --claims ./gnosischain/claims.csv --network gnosischain
```

The output files are in the `output/deployment-gc` folder, which include:
2. `addresses.json`, a list with on entry: the newly deployed BridgedTokenDeployer.
3. `claims.json`, a list of all the claims of all user. It contains all information needed by a user to perform a claim onchain. 
4. `chunks` and `mapping.json`, which contain a reorganized version of the same claims that are available in `claims.json`. This format is easier to handle by a web frontend. The format is very similar to the one used in the Uniswap airdrop.

Run the verifier to check that your deployment was successful:
```
npx hardhat verify-contract-code --bridged-token-deployer  "<address from addresses.json>" --network gnosischain  
```
and copy \<address from addresses.json\> into the settings.json for the entry `bridgedTokenDeployer` for the next step.


#### 2nd step: Mainnet proposal creation

```
source example/mainnet/.env
npx hardhat deployment --claims ./mainnet/claims.csv --settings ./settings.json --network mainnet 
```

This script is deterministic and can be used to verify the transactions proposed to the Gnosis DAO.

The output files are in the `output/deployment` folder, which include:
1. `steps.json`, a list of transactions to be executed from the Gnosis DAO in the proposal.
2. `addresses.json`, a list of (deterministically generated) contract addresses that will result from executing the deployment onchain.
3. `claims.json`, a list of all the claims of all user. It contains all information needed by a user to perform a claim onchain. 
4. `chunks` and `mapping.json`, which contain a reorganized version of the same claims that are available in `claims.json`. This format is easier to handle by a web frontend.
5. `txhashes.json`, the hashes of all transactions appearing in the proposal. They can be used to verify that the proposal was created correctly.

The format is very similar to the one used in the Uniswap airdrop.

### Verify GIP-13 proposal

The scripts in this repo have been used to generate the [snapshot proposal](https://snapshot.org/#/gnosis.eth/proposal/0x9b12a093e17e92b56d070ed876883d8c2331678ca3945e44f66dd416cfd47a64) for the [Gnosis Improvement Proposal #13](https://forum.gnosis.io/t/gip-13-gnosis-protocol-token/1529).

Deployments on both mainnet and Gnosis Chain can be verified with the tooling in this repo.

#### Mainnet

You can verifying the correctness of the transactions by running:

```
source example/mainnet/.env # fill the env file with the required parameters
wget https://raw.githubusercontent.com/gnosis/cow-token-allocation/2111ee1e678be345ba8b33e80be5fa0d0ed780f4/allocations-mainnet.csv
npx hardhat deployment --network mainnet --claims ./allocations-mainnet.csv --settings ./example/gip-cow-deployment-settings.json
```

The output file `./output/deployment/txhashes.json` contains the hashes of all transactions that are included in the snapshot and can be compared to the batch transaction hashes that are shown in the Snapshot interface.

#### Gnosis Chain

A factory contract was deployed on Gnosis Chain to facilitate the deployment of the virtual token contract through a mainnet proposal.
The correctness of the contract parameters can be checked with:

```
source example/gnosischain/.env # fill the env file with the required parameters
wget https://raw.githubusercontent.com/gnosis/cow-token-allocation/2111ee1e678be345ba8b33e80be5fa0d0ed780f4/allocations-gchain.csv
npx hardhat deployment-bridged-token-deployer --network gnosischain --claims ./allocations-gchain.csv --settings ./example/gip-cow-deployment-settings.json --verify
```

The terminal output of the script will show whether the verification process was successful. 

### Test deployment

A script that can be used to create a live test deployment of the token contract on the supported networks.
It generates claims based on an input CSV file. See the [example section](#example-csv-file-with-claims) for how to generate a valid CSV file.

The script also deploys all administration Gnosis Safe, for example the DAOs and the funds targets. By default, they will be owned by the deployer address.

Here is an example of how to run a deployment:
```
export INFURA_KEY='insert your Infura key here'
export PK='insert you private key here'
npx hardhat test-deployment --network $NETWORK /path/to/claims.csv
```

The output files can be found in the `output/test-deployment` folder, which include the addresses of the deployed Gnosis Safes (file `params.json`).

More advanced options can be listed by running `npx hardhat test-deployment --help`.

The deployed contract code can be verified on the block explorer immediately after deploying with:

```
export ETHERSCAN_API_KEY='insert your Etherscan API key here'
yarn verify --use-test-deployment-params --network $NETWORK
```

### Example CSV file with claims

A script is available to generate a CSV file containing pseudorandom claims for testing.
It generates private keys for each user based on a mnemonic parameter. To each of these users will be assigned different claim combinations.
Any valid combination of claim types can be found among the generated addresses.

Example usage:
```
npx hardhat test-claims --user-count 10000 --mnemonic "candy maple cake sugar pudding cream honey rich smooth crumble sweet treat"
```

The computed private keys and the CSV file containing all the claims are stored in the folder `output/test-claims`.

### Verifying contract code

For verifying the deployed contracts on Etherscan:

```sh
export INFURA_KEY='insert your Infura key here'
export ETHERSCAN_API_KEY='insert your Etherscan/Gnosisscan/... API key here'
yarn verify --virtual-token $VIRTUAL_TOKEN_ADDRESS --network $NETWORK
```

It is currently only possible to verify the contract code on Etherscan-type block explorers.

### Computing the Merkle Root

To just compute the merkle root of a given claim file, use the following script

```
yarn hardhat compute-merkle-root --claims <path to csv>
```

## Use the code in another project

The Solidity contract code, contract ABIs, and Typescript library code are available through the NPM package `@cowprotocol/token`.

If your project uses yarn, you can install this package with:

```sh
yarn add @cowprotocol/token
```

### Claim for many addresses

You can use a script to claim multiple times for different addresses using a single private key.

It requires the CSV list of all available claims and a file containing a comma-separated list of addresses that will see their claims executed.
It can be run with:

```sh
npx hardhat mass-claim --network $NETWORK --pay-usdc --pay-gno --pay-weth --claim-csv "$PATH_TO_CSV_CLAIMS_FILE" --claim-targets "$PATH_TO_COMMA_SEPARATED_ADDRESS_FILE" --v-cow-token $VCOW_TOKEN_ADDRESS
```

The script assumes there are enough USDC, GNO, and WETH funds in the private key to execute all claims.
If not, you can omit specific paid claim types by omitting any of the `--pay-*` flags.
