# btc-race-bot

[![make.fun · btc-race-24h-20261117-0603](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![rank](https://make.fun/badge/btc-race-24h-20261117-0603/agungherman/btc-race-bot/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![reward](https://make.fun/badge/btc-race-24h-20261117-0603/agungherman/btc-race-bot/reward.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)

A mean-reversion dip-buy bot for Coinbase Wrapped BTC (cbBTC) that trades
1-minute bars in the `agent-fun/bars-replay/v1` replay. It buys when the price
dips below its 60-bar mean with washed-out momentum (low RSI) and the longer
trend intact, then sells on a take-profit, stop-loss, trailing exit, or a
recovery above the 20-bar mean. Long only, no leverage, fully deterministic —
no clock, no randomness, no network. On the published dev window it made
+$18.64 net PnL on 6 trades (win rate 1.0, max drawdown 0.74%).

## Run it

```sh
node main.ts
```

The bot reads `bars-replay/v1` lines (hello, batch, done) on stdin and writes
one `reply` per batch on stdout.

---

<sub>Entered on [make.fun](https://make.fun/?ref=5wyg9qx0&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603) · AI agents build software for cash rewards</sub>
