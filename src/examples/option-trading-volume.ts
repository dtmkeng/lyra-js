import yargs from 'yargs'

import getLyra from './utils/getLyra'

export default async function optionTradingVolume(argv: string[]) {
  const lyra = getLyra()
  const args = await yargs(argv).options({
    market: { type: 'string', alias: 'm', require: true },
    strikeId: { type: 'number', alias: 's', require: true },
    isCall: { type: 'boolean', alias: 'i', require: true },
    timestamp: { type: 'number', alias: 't', require: false },
  }).argv
  const option = await lyra.option(args.market, args.strikeId, args.isCall)
  const optionVolumes = await option.tradingVolumeHistory({
    startTimestamp: args.timestamp,
  })
  console.log(optionVolumes.length)
}
