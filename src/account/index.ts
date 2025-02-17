import { getAddress } from '@ethersproject/address'
import { BigNumber } from '@ethersproject/bignumber'
import { PopulatedTransaction } from '@ethersproject/contracts'

import { ONE_BN, UNIT, ZERO_BN } from '../constants/bn'
import {
  Deployment,
  LYRA_OPTIMISM_KOVAN_ADDRESS,
  LYRA_OPTIMISM_MAINNET_ADDRESS,
  LyraContractId,
  LyraMarketContractId,
  OP_OPTIMISM_MAINNET_ADDRESS,
  STAKED_LYRA_OPTIMISM_ADDRESS,
  STAKED_LYRA_OPTIMISM_KOVAN_ADDRESS,
} from '../constants/contracts'
import { LiquidityDeposit } from '../liquidity_deposit'
import { LiquidityWithdrawal } from '../liquidity_withdrawal'
import Lyra from '../lyra'
import { LyraStaking } from '../lyra_staking'
import { Market } from '../market'
import { Stake } from '../stake'
import { Unstake } from '../unstake'
import buildTxWithGasEstimate from '../utils/buildTxWithGasEstimate'
import getERC20Contract from '../utils/getERC20Contract'
import getLyraContract from '../utils/getLyraContract'
import getLyraContractAddress from '../utils/getLyraContractAddress'
import getLyraMarketContract from '../utils/getLyraMarketContract'
import getAccountBalancesAndAllowances from './getAccountBalancesAndAllowances'
import getAverageCostPerLPToken from './getAverageCostPerLPToken'
import getLiquidityDepositBalance from './getLiquidityDepositBalance'
import getLiquidityTokenBalance from './getLiquidityTokenBalance'
import getPortfolioBalance from './getPortfolioBalance'
import getPortfolioHistory from './getPortfolioHistory'

export type AccountPortfolioHistorySnapshot = {
  timestamp: number
  longOptionValue: number
  shortOptionValue: number
  collateralValue: number
  balance: number
  total: number
}

export type AccountPortfolioBalance = {
  longOptionValue: number
  shortOptionValue: number
  collateralValue: number
  balance: number
  total: number
}

export type AccountBalanceHistory = {
  timestamp: number
  balance: BigNumber
}

export type AccountShortOptionHistory = {
  timestamp: number
  optionValue: BigNumber
  collateralValue: BigNumber
}

export type AccountLongOptionHistory = {
  timestamp: number
  optionValue: BigNumber
}

export type AccountPortfolioHistory = AccountPortfolioHistorySnapshot[]

export type AccountStableBalance = {
  address: string
  symbol: string
  decimals: number
  balance: BigNumber
  allowance: BigNumber
}

export type AccountBaseBalance = {
  marketAddress: string
  address: string
  symbol: string
  decimals: number
  balance: BigNumber
  allowance: BigNumber
}

export type AccountOptionTokenBalance = {
  marketAddress: string
  address: string
  isApprovedForAll: boolean
}

export type AccountLiquidityTokenBalance = {
  market: Market
  address: string
  balance: BigNumber
  value: BigNumber
  tokenPrice: BigNumber
  symbol: string
  decimals: number
  allowance: BigNumber
}

export type AccountLiquidityProfitAndLoss = {
  balance: BigNumber
  averageTokenPrice: BigNumber
}

export type AccountBalances = {
  stables: AccountStableBalance[]
  stable: (tokenAddressOrName: string) => AccountStableBalance
  bases: AccountBaseBalance[]
  base: (tokenOrMarketAddressOrName: string) => AccountBaseBalance
  optionTokens: AccountOptionTokenBalance[]
  optionToken: (tokenOrMarketAddress: string) => AccountOptionTokenBalance
}

export type AccountLyraStaking = {
  staking: LyraStaking
  lyraBalance: AccountLyraBalance
  stakedLyraBalance: AccountStakedLyraBalance
  isInUnstakeWindow: boolean
  isInCooldown: boolean
  unstakeWindowStartTimestamp: number | null
  unstakeWindowEndTimestamp: number | null
}

export type AccountLyraBalance = {
  balance: BigNumber
  stakingAllowance: BigNumber
}

export type AccountStakedLyraBalance = {
  balance: BigNumber
}

export type ClaimableBalance = {
  op: BigNumber
  lyra: BigNumber
}

export class Account {
  private lyra: Lyra
  address: string

  constructor(lyra: Lyra, address: string) {
    this.lyra = lyra
    this.address = address
  }

  // Getters

  static get(lyra: Lyra, account: string): Account {
    return new Account(lyra, account)
  }

  // Dynamic Fields

  async balances(): Promise<AccountBalances> {
    const { stables, bases, optionTokens } = await getAccountBalancesAndAllowances(this.lyra, this.address)
    const stable = (tokenAddressOrName: string): AccountStableBalance => {
      const stable = stables.find(
        stable =>
          stable.address.toLowerCase() === tokenAddressOrName.toLowerCase() ||
          stable.symbol.toLowerCase() === tokenAddressOrName.toLowerCase()
      )
      if (!stable) {
        throw new Error('Stable token does not exist')
      }
      return stable
    }
    const base = (tokenOrMarketAddressOrName: string): AccountBaseBalance => {
      const base = bases.find(
        base =>
          [base.marketAddress.toLowerCase(), base.address.toLowerCase()].includes(
            tokenOrMarketAddressOrName.toLowerCase()
          ) || base.symbol.toLowerCase() === tokenOrMarketAddressOrName.toLowerCase()
      )
      if (!base) {
        throw new Error('Base token does not exist')
      }
      return base
    }
    const optionToken = (tokenOrMarketAddress: string): AccountOptionTokenBalance => {
      const optionToken = optionTokens.find(optionToken =>
        [optionToken.marketAddress.toLowerCase(), optionToken.address.toLowerCase()].includes(
          tokenOrMarketAddress.toLowerCase()
        )
      )
      if (!optionToken) {
        throw new Error('Option token does not exist')
      }
      return optionToken
    }
    return {
      stables,
      stable,
      bases,
      base,
      optionTokens,
      optionToken,
    }
  }

  async liquidityDepositBalance(marketAddressOrName: string): Promise<AccountStableBalance> {
    const market = await this.lyra.market(marketAddressOrName)
    return await getLiquidityDepositBalance(this.lyra, this.address, market)
  }

  async liquidityTokenBalance(marketAddressOrName: string): Promise<AccountLiquidityTokenBalance> {
    const market = await this.lyra.market(marketAddressOrName)
    return await getLiquidityTokenBalance(this.lyra, this.address, market)
  }

  async liquidityUnrealizedPnl(marketAddressOrName: string): Promise<{ pnl: BigNumber; pnlPercent: BigNumber }> {
    const [{ balance, value, tokenPrice }, liquidityDeposits, liquidityWithdrawals] = await Promise.all([
      this.liquidityTokenBalance(marketAddressOrName),
      this.lyra.liquidityDeposits(marketAddressOrName, this.address),
      this.lyra.liquidityWithdrawals(marketAddressOrName, this.address),
    ])
    const avgCostPerToken = getAverageCostPerLPToken(liquidityDeposits, liquidityWithdrawals)
    const avgValue = avgCostPerToken.mul(balance).div(UNIT)
    const pnl = value.sub(avgValue)
    const pnlPercent = avgCostPerToken.gt(0) ? tokenPrice.mul(UNIT).div(avgCostPerToken).sub(ONE_BN) : ZERO_BN
    return {
      pnl,
      pnlPercent,
    }
  }

  async lyraBalance(): Promise<AccountLyraBalance> {
    const lyraTokenContract = getERC20Contract(
      this.lyra.provider,
      this.lyra.deployment === Deployment.Mainnet ? LYRA_OPTIMISM_MAINNET_ADDRESS : LYRA_OPTIMISM_KOVAN_ADDRESS
    )
    const lyraStakingModuleProxyAddress = getLyraContractAddress(
      this.lyra.deployment,
      LyraContractId.LyraStakingModuleProxy
    )
    const [balance, stakingAllowance] = await Promise.all([
      lyraTokenContract.balanceOf(this.address),
      lyraTokenContract.allowance(this.address, lyraStakingModuleProxyAddress),
    ])
    return {
      balance,
      stakingAllowance,
    }
  }

  async stakedLyraBalance(): Promise<AccountStakedLyraBalance> {
    const stakedLyraContract = getERC20Contract(
      this.lyra.provider,
      this.lyra.deployment === Deployment.Mainnet ? STAKED_LYRA_OPTIMISM_ADDRESS : STAKED_LYRA_OPTIMISM_KOVAN_ADDRESS
    ) // BLOCK: @dillonlin change address to mainnet
    const balance = await stakedLyraContract.balanceOf(this.address)
    return {
      balance,
    }
  }

  async claimableRewards(): Promise<ClaimableBalance> {
    const distributorContract = getLyraContract(
      this.lyra.provider,
      this.lyra.deployment,
      LyraContractId.MultiDistributor
    )
    const stkLyraAddress = getAddress(
      this.lyra.deployment === Deployment.Mainnet ? STAKED_LYRA_OPTIMISM_ADDRESS : STAKED_LYRA_OPTIMISM_KOVAN_ADDRESS
    )
    const opAddress =
      this.lyra.deployment === Deployment.Mainnet ? OP_OPTIMISM_MAINNET_ADDRESS : LYRA_OPTIMISM_KOVAN_ADDRESS
    const [stkLyraClaimableBalance, opClaimableBalance] = await Promise.all([
      distributorContract.claimableBalances(this.address, stkLyraAddress),
      distributorContract.claimableBalances(this.address, opAddress),
    ])
    return {
      lyra: stkLyraClaimableBalance ?? ZERO_BN,
      op: opClaimableBalance ?? ZERO_BN,
    }
  }

  async claim(tokenAddresses: string[]): Promise<PopulatedTransaction> {
    const distributorContract = getLyraContract(
      this.lyra.provider,
      this.lyra.deployment,
      LyraContractId.MultiDistributor
    )
    const calldata = distributorContract.interface.encodeFunctionData('claim', [tokenAddresses])
    return await buildTxWithGasEstimate(this.lyra, distributorContract.address, this.address, calldata)
  }

  // Approval

  async approveOptionToken(marketAddressOrName: string, isAllowed: boolean): Promise<PopulatedTransaction> {
    const market = await Market.get(this.lyra, marketAddressOrName)
    const optionToken = getLyraMarketContract(this.lyra, market.contractAddresses, LyraMarketContractId.OptionToken)
    const wrapper = getLyraContract(this.lyra.provider, this.lyra.deployment, LyraContractId.OptionMarketWrapper)
    const data = optionToken.interface.encodeFunctionData('setApprovalForAll', [wrapper.address, isAllowed])
    const tx = await buildTxWithGasEstimate(this.lyra, optionToken.address, this.address, data)
    if (!tx) {
      throw new Error('Failed to estimate gas for setApprovalForAll transaction')
    }
    return tx
  }

  async approveStableToken(tokenAddressOrName: string, amount: BigNumber): Promise<PopulatedTransaction> {
    const balances = await this.balances()
    const stable = balances.stable(tokenAddressOrName)
    const wrapper = getLyraContract(this.lyra.provider, this.lyra.deployment, LyraContractId.OptionMarketWrapper)
    const erc20 = getERC20Contract(this.lyra.provider, stable.address)
    const data = erc20.interface.encodeFunctionData('approve', [wrapper.address, amount])
    const tx = await buildTxWithGasEstimate(this.lyra, erc20.address, this.address, data)
    return tx
  }

  async approveBaseToken(tokenOrMarketAddressOrName: string, amount: BigNumber): Promise<PopulatedTransaction> {
    const balances = await this.balances()
    const stable = balances.base(tokenOrMarketAddressOrName)
    const wrapper = getLyraContract(this.lyra.provider, this.lyra.deployment, LyraContractId.OptionMarketWrapper)
    const erc20 = getERC20Contract(this.lyra.provider, stable.address)
    const data = erc20.interface.encodeFunctionData('approve', [wrapper.address, amount])
    const tx = await buildTxWithGasEstimate(this.lyra, erc20.address, this.address, data)
    return tx
  }

  async drip(): Promise<PopulatedTransaction> {
    if (![Deployment.Kovan, Deployment.Local].includes(this.lyra.deployment)) {
      throw new Error('Faucet is only supported on local and kovan contracts')
    }
    const faucet = getLyraContract(this.lyra.provider, this.lyra.deployment, LyraContractId.TestFaucet)
    const data = faucet.interface.encodeFunctionData('drip')
    const tx = await buildTxWithGasEstimate(this.lyra, faucet.address, this.address, data)
    if (!tx) {
      throw new Error('Failed to estimate gas for drip transaction')
    }
    return tx
  }

  async approveDeposit(marketAddressOrName: string, amount: BigNumber): Promise<PopulatedTransaction> {
    const susd = await this.liquidityDepositBalance(marketAddressOrName)
    const market = await Market.get(this.lyra, marketAddressOrName)
    const liquidityPoolContract = getLyraMarketContract(
      this.lyra,
      market.contractAddresses,
      LyraMarketContractId.LiquidityPool
    )
    const erc20 = getERC20Contract(this.lyra.provider, susd.address)
    const data = erc20.interface.encodeFunctionData('approve', [liquidityPoolContract.address, amount])
    const tx = await buildTxWithGasEstimate(this.lyra, erc20.address, this.address, data)
    return tx
  }

  async deposit(
    marketAddressOrName: string,
    beneficiary: string,
    amountQuote: BigNumber
  ): Promise<PopulatedTransaction | null> {
    return await LiquidityDeposit.deposit(this.lyra, marketAddressOrName, beneficiary, amountQuote)
  }

  async withdraw(
    marketAddressOrName: string,
    beneficiary: string,
    amountLiquidityTokens: BigNumber
  ): Promise<PopulatedTransaction | null> {
    return await LiquidityWithdrawal.withdraw(this.lyra, marketAddressOrName, beneficiary, amountLiquidityTokens)
  }

  async lyraStaking(): Promise<AccountLyraStaking> {
    const lyraStakingModuleProxyContract = getLyraContract(
      this.lyra.provider,
      this.lyra.deployment,
      LyraContractId.LyraStakingModuleProxy
    )
    const [block, lyraBalance, stakedLyraBalance, staking, accountCooldownBN] = await Promise.all([
      this.lyra.provider.getBlock('latest'),
      this.lyraBalance(),
      this.stakedLyraBalance(),
      this.lyra.lyraStaking(),
      lyraStakingModuleProxyContract.stakersCooldowns(this.address),
    ])
    const accountCooldown = accountCooldownBN.toNumber()
    const cooldownStartTimestamp = accountCooldown > 0 ? accountCooldown : null
    const cooldownEndTimestamp = accountCooldown > 0 ? accountCooldown + staking.cooldownPeriod : null
    const unstakeWindowStartTimestamp = cooldownEndTimestamp
    const unstakeWindowEndTimestamp = unstakeWindowStartTimestamp
      ? unstakeWindowStartTimestamp + staking.unstakeWindow
      : null
    const isInUnstakeWindow =
      !!unstakeWindowStartTimestamp &&
      !!unstakeWindowEndTimestamp &&
      block.timestamp >= unstakeWindowStartTimestamp &&
      block.timestamp <= unstakeWindowEndTimestamp
    const isInCooldown =
      !!cooldownStartTimestamp &&
      !!cooldownEndTimestamp &&
      block.timestamp >= cooldownStartTimestamp &&
      block.timestamp <= cooldownEndTimestamp
    return {
      staking,
      lyraBalance,
      stakedLyraBalance,
      isInUnstakeWindow,
      isInCooldown,
      unstakeWindowStartTimestamp,
      unstakeWindowEndTimestamp,
    }
  }

  async approveStake(): Promise<PopulatedTransaction> {
    return await Stake.approve(this.lyra, this.address)
  }

  async stake(amount: BigNumber): Promise<Stake> {
    return await Stake.get(this.lyra, this.address, amount)
  }

  async requestUnstake(): Promise<PopulatedTransaction> {
    return await Unstake.requestUnstake(this.lyra, this.address)
  }

  async unstake(amount: BigNumber): Promise<Unstake> {
    return await Unstake.get(this.lyra, this.address, amount)
  }

  // Edges

  async liquidityDeposits(marketAddressOrName: string): Promise<LiquidityDeposit[]> {
    return await this.lyra.liquidityDeposits(marketAddressOrName, this.address)
  }

  async liquidityWithdrawals(marketAddressOrName: string): Promise<LiquidityWithdrawal[]> {
    return await this.lyra.liquidityWithdrawals(marketAddressOrName, this.address)
  }

  async portfolioHistory(startTimestamp: number): Promise<AccountPortfolioHistory> {
    const endTimestamp = (await this.lyra.provider.getBlock('latest')).timestamp
    return await getPortfolioHistory(this.lyra, this.address, startTimestamp, endTimestamp)
  }

  async portfolioBalance(): Promise<AccountPortfolioBalance> {
    return await getPortfolioBalance(this.lyra, this.address)
  }
}
