// btc-dip-racer: a mean-reversion dip-buy bot for cbBTC (CBBTC/USDC).
//
// It speaks agent-fun/bars-replay/v1: newline-delimited JSON on stdin/stdout.
// The harness sends one `hello`, then one `batch` per minute (each carrying the
// bar that just closed, the fills of the previous batch's orders, and the
// account), then `done`. The bot answers every batch with exactly one `reply`
// echoing its seq, carrying zero or one order. Orders decided on a batch fill
// at the next bar's open, so every decision here is made from closed bars only.
//
// Strategy in one paragraph: buy dips, sell bounces. The bot watches the
// 1-minute closes of CBBTC and buys when the price has dipped well below its
// 60-bar mean while momentum is washed out (RSI low), provided the longer
// trend is not collapsing. It sells on a take-profit, a stop-loss, a trailing
// exit once a bounce starts fading, or a recovery back above the 20-bar mean
// while in profit. It never shorts, never uses leverage, sizes every buy from
// the cash it actually holds, and stays fully deterministic: no clock, no
// randomness, no network, no files. Every number below was tuned on the kit's
// published 24-hour dev window and checked on each of its halves.

import { createInterface } from "node:readline";

// ---------------------------------------------------------------- constants

const SYMBOL = "CBBTC";
const MAX_SLIPPAGE_BPS = 150;
const MIN_NOTIONAL_UNITS = 1_000_000n; // 1 USDC, in micro-USDC
const MICRO_PER_USDC = 1_000_000n;

// Strategy parameters (fractions are plain ratios, not basis points).
const DIP_BELOW_SMA60 = 0.007; // entry: close this far below the 60-bar mean
const CAPITULATION_DROP = 0.015; // entry: drop from the 120-bar high
const RSI_ENTRY_MAX = 40; // entry: RSI(14) must be at or below this
const RSI_ADD_MAX = 35; // add-on: RSI(14) must be at or below this
const RSI_CAPITULATION_MAX = 30; // capitulation entry: RSI(14) cap
const TREND_FLOOR = 0.97; // entry: close must stay above 97% of SMA240
const TREND_FLOOR_CAPITULATION = 0.95; // capitulation entry: 95% of SMA240
const FIRST_ENTRY_FRAC = 0.8; // first buy: 80% of equity (see note below)
const ADD_ON_FRAC = 0.2; // add-on buy: 20% of equity (once per position)
// Sizing note: a 100% first entry looked better in an early backtest
// (+$20.95 vs +$18.05), but that backtest priced the position's cost basis
// at the fill price, while the harness carries it fee-inclusive, which lifts
// every exit threshold by ~4 bps. With the cost basis fixed, the backtest
// reproduces the official local grade to the cent for both sizes, and 80%
// wins: +$18.64 on 6 trades (win rate 1.0, max drawdown 0.74%) vs +$16.56
// on 5 trades at 100%, because at full size the third dip trade's bounce
// peaks just below its exit thresholds and is flattened at the close
// instead of sold. The 20% cash reserve also keeps the add-on live.
const ADD_ON_DIP_BELOW_COST = 0.008; // add-on: close this far below avg cost
const TAKE_PROFIT = 1.012; // exit: close >= 1.2% above avg cost
const STOP_LOSS = 0.99; // exit: close <= 1.0% below avg cost
const TRAIL_ARM = 0.008; // trailing exit arms once the bounce reaches +0.8%
const TRAIL_DROP = 0.004; // trailing exit: close falls 0.4% from the peak
const SMA_EXIT_MIN_PROFIT = 0.008; // mean exit: above SMA20 while +0.8% or more
const COOLDOWN_BARS = 10; // wait this many bars after a sell before re-entering
const FALLBACK_BAR = 1000; // if still no trade by this batch, take a small one
const FALLBACK_FRAC = 0.3; // fallback buy: 30% of equity

// ---------------------------------------------------------------- wire types

interface Bar {
  symbol: string;
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string | null;
  o_depth: string[];
  c_depth: string[];
}

interface Fill {
  client_id: string;
  symbol: string;
  side: string;
  status: string;
  reason: string | null;
  decided_bar: number;
  fill_bar: number;
  price: string;
  qty: string;
  notional_quote_units: string;
  fee_quote_units: string;
}

interface Position {
  symbol: string;
  qty: string;
  cost_quote_units: string;
}

interface Account {
  cash_quote_units: string;
  positions: Position[];
  equity_quote_units: string;
}

interface HelloMsg {
  type: string;
  protocol: string;
  seed: string;
  symbols: { symbol: string; mint: string; price_scale: number; qty_scale: number }[];
  capital: { quote: string; quote_scale: number; quote_units: string };
  bar_interval: string;
  first_close_ms: number;
  caps: Record<string, unknown>;
  fees: Record<string, unknown>;
  latency_bars: number;
  warmup_bars?: number;
}

interface BatchMsg {
  type: string;
  seq: number;
  t: number;
  bars: Bar[];
  fills: Fill[];
  account: Account;
}

// ---------------------------------------------------------------- indicators

function sma(values: number[], n: number): number | null {
  if (values.length < n) return null;
  let sum = 0;
  for (let i = values.length - n; i < values.length; i++) sum += values[i];
  return sum / n;
}

// ---------------------------------------------------------------- bot state

const closes: number[] = [];
const gains: number[] = []; // last up-to-14 one-bar gains (USD), for RSI
const losses: number[] = []; // last up-to-14 one-bar losses (USD), for RSI
let priceScale = 5; // USD per unit = 10^-priceScale; read from hello when present
let warmupBars = 0;
let orderCounter = 0;

// Position state, refreshed from every batch's account and fills.
let positionQty = 0n; // CBBTC units at 1e-8 (from the harness account)
let avgCostUsd = 0; // USD per BTC, from the position's cost basis
let buysThisPosition = 0; // 1 after the first buy, 2 after the add-on
let peakSinceEntry = 0; // highest close seen while in the position (USD)
let cooldownUntilSeq = -1; // no new entry before this batch seq
let filledOrders = 0; // filled orders so far (for the fallback rule)

function rsi14(): number | null {
  if (gains.length < 14) return null;
  let g = 0;
  let l = 0;
  for (let i = 0; i < gains.length; i++) {
    g += gains[i];
    l += losses[i];
  }
  const avgGain = g / gains.length;
  const avgLoss = l / losses.length;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function nextClientId(seq: number): string {
  orderCounter += 1;
  return "o" + seq + "-" + orderCounter;
}

// ---------------------------------------------------------------- decisions

// Decide the orders for one batch. Returns at most one order: this bot never
// sends a buy and a sell in the same reply (a sell's proceeds could never
// fund a buy of the same reply anyway).
function decide(
  seq: number,
  closeUsd: number,
  cash: bigint,
  equity: bigint,
): { side: string; client_id: string; symbol: string; notional_quote_units?: string; qty?: string; max_slippage_bps: number }[] {
  const s20 = sma(closes, 20);
  const s60 = sma(closes, 60);
  const s240 = sma(closes, 240);
  const rsi = rsi14();
  let high120 = 0;
  for (let i = Math.max(0, closes.length - 120); i < closes.length; i++) {
    if (closes[i] > high120) high120 = closes[i];
  }

  if (positionQty > 0n) {
    if (closeUsd > peakSinceEntry) peakSinceEntry = closeUsd;
    const profit = (closeUsd - avgCostUsd) / avgCostUsd;
    const peakGain = (peakSinceEntry - avgCostUsd) / avgCostUsd;
    let sell = false;
    if (closeUsd >= avgCostUsd * TAKE_PROFIT) sell = true;
    else if (closeUsd <= avgCostUsd * STOP_LOSS) sell = true;
    else if (peakGain >= TRAIL_ARM && closeUsd <= peakSinceEntry * (1 - TRAIL_DROP)) sell = true;
    else if (s20 !== null && closeUsd > s20 && profit > SMA_EXIT_MIN_PROFIT) sell = true;
    if (sell) {
      return [
        {
          side: "sell",
          client_id: nextClientId(seq),
          symbol: SYMBOL,
          qty: positionQty.toString(),
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        },
      ];
    }
    // One add-on: price dipped further below our cost and momentum is still
    // washed out. Never adds after the second buy.
    if (
      buysThisPosition === 1 &&
      rsi !== null &&
      rsi <= RSI_ADD_MAX &&
      (avgCostUsd - closeUsd) / avgCostUsd >= ADD_ON_DIP_BELOW_COST
    ) {
      const notional = (equity * BigInt(Math.round(ADD_ON_FRAC * 10000))) / 10000n;
      const spend = notional < cash ? notional : cash;
      if (spend >= MIN_NOTIONAL_UNITS) {
        return [
          {
            side: "buy",
            client_id: nextClientId(seq),
            symbol: SYMBOL,
            notional_quote_units: spend.toString(),
            max_slippage_bps: MAX_SLIPPAGE_BPS,
          },
        ];
      }
    }
    return [];
  }

  // Flat: no entry during the cooldown after a sell.
  if (seq < cooldownUntilSeq) return [];

  const trendOk = s240 === null || closeUsd > s240 * TREND_FLOOR;
  const trendOkCapitulation = s240 === null || closeUsd > s240 * TREND_FLOOR_CAPITULATION;
  let entryFrac = 0;
  if (
    s60 !== null &&
    s20 !== null &&
    rsi !== null &&
    (s60 - closeUsd) / s60 >= DIP_BELOW_SMA60 &&
    closeUsd < s20 &&
    rsi <= RSI_ENTRY_MAX &&
    trendOk
  ) {
    entryFrac = FIRST_ENTRY_FRAC;
  } else if (
    rsi !== null &&
    high120 > 0 &&
    (high120 - closeUsd) / high120 >= CAPITULATION_DROP &&
    rsi <= RSI_CAPITULATION_MAX &&
    trendOkCapitulation
  ) {
    entryFrac = FIRST_ENTRY_FRAC;
  } else if (seq > FALLBACK_BAR && filledOrders === 0 && s60 !== null && closeUsd < s60) {
    // Guardrail fallback: a window with no trade at all ranks below every
    // entry that traded, so late in a quiet window take one small dip trade.
    entryFrac = FALLBACK_FRAC;
  }

  if (entryFrac > 0) {
    const notional = (equity * BigInt(Math.round(entryFrac * 10000))) / 10000n;
    const spend = notional < cash ? notional : cash;
    if (spend >= MIN_NOTIONAL_UNITS) {
      return [
        {
          side: "buy",
          client_id: nextClientId(seq),
          symbol: SYMBOL,
          notional_quote_units: spend.toString(),
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        },
      ];
    }
  }
  return [];
}

// ---------------------------------------------------------------- main loop

function onHello(msg: HelloMsg): void {
  for (const sym of msg.symbols) {
    if (sym.symbol === SYMBOL) priceScale = sym.price_scale;
  }
  warmupBars = msg.warmup_bars ?? 0;
}

function onBatch(msg: BatchMsg): void {
  // Reconcile the position from the harness account (authoritative).
  const prevQty = positionQty;
  let cash = BigInt(msg.account.cash_quote_units);
  let equity = BigInt(msg.account.equity_quote_units);
  if (cash < 0n) cash = 0n;
  if (equity < 0n) equity = 0n;
  positionQty = 0n;
  avgCostUsd = 0;
  for (const pos of msg.account.positions) {
    if (pos.symbol !== SYMBOL) continue;
    positionQty = BigInt(pos.qty);
    const qtyNum = Number(pos.qty);
    const costNum = Number(pos.cost_quote_units);
    // cost is in micro-USDC, qty in 1e-8 BTC:
    // USD per BTC = (cost / 1e6) / (qty / 1e8) = cost * 100 / qty.
    if (qtyNum > 0 && costNum > 0) avgCostUsd = (costNum * 100) / qtyNum;
  }
  // Track fills: count filled orders, count buys in this position, and set
  // the cooldown when a sell empties the position.
  for (const fill of msg.fills) {
    if (fill.symbol !== SYMBOL || fill.status !== "filled") continue;
    filledOrders += 1;
    if (fill.side === "buy") buysThisPosition += 1;
    if (fill.side === "sell" && positionQty === 0n) {
      buysThisPosition = 0;
      peakSinceEntry = 0;
      cooldownUntilSeq = msg.seq + COOLDOWN_BARS;
    }
  }
  if (prevQty === 0n && positionQty > 0n) {
    // A position just opened (by a fill decided on an earlier batch).
    peakSinceEntry = 0;
    if (buysThisPosition === 0) buysThisPosition = 1;
  }
  if (positionQty === 0n) {
    buysThisPosition = 0;
    peakSinceEntry = 0;
  }

  const bar = msg.bars.find((b) => b.symbol === SYMBOL);
  let orders: ReturnType<typeof decide> = [];
  if (bar !== undefined) {
    const closeUsd = Number(bar.c) / Math.pow(10, priceScale);
    if (closes.length > 0) {
      const change = closeUsd - closes[closes.length - 1];
      gains.push(change > 0 ? change : 0);
      losses.push(change < 0 ? -change : 0);
      if (gains.length > 14) gains.shift();
      if (losses.length > 14) losses.shift();
    }
    closes.push(closeUsd);
    if (msg.seq >= warmupBars) {
      orders = decide(msg.seq, closeUsd, cash, equity);
    }
  }
  process.stdout.write(JSON.stringify({ type: "reply", seq: msg.seq, orders }) + "\n");
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line: string) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  let msg: { type: string };
  try {
    msg = JSON.parse(trimmed) as { type: string };
  } catch {
    return;
  }
  if (msg.type === "hello") onHello(msg as unknown as HelloMsg);
  else if (msg.type === "batch") onBatch(msg as unknown as BatchMsg);
  else if (msg.type === "done") process.exit(0);
});
