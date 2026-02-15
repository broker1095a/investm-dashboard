/**
 * BTC Dashboard v3.5 — Node.js Backend
 * Portfolio: 982 BTC bought at $65,188 average
 * Auto-updates from CoinGecko, Alternative.me, Binance APIs
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const https = require('https');
const http = require('http');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'static')));

// ─── Portfolio Config ───
const PORTFOLIO_BTC = 982;
const PORTFOLIO_AVG_PRICE = 65188;
const PORTFOLIO_INVESTED = PORTFOLIO_BTC * PORTFOLIO_AVG_PRICE; // $64,014,616

// ─── Cache ───
let cache = {
    data: null,
    historical: {},
    lastUpdate: 0,
    updateInterval: 60000 // 60 seconds
};

// ─── HTTP/HTTPS fetch helper ───
function fetchJSON(url, timeout = 10000) {
    return new Promise((resolve, reject) => {
        const lib = url.startsWith('https') ? https : http;
        const req = lib.get(url, {
            headers: {
                'User-Agent': 'BTC-Dashboard/3.5',
                'Accept': 'application/json'
            },
            timeout: timeout
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    // Some endpoints return raw numbers
                    const num = parseFloat(data);
                    if (!isNaN(num)) resolve(num);
                    else reject(new Error(`Parse error: ${data.substring(0, 100)}`));
                }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    });
}

async function safeFetch(url, timeout = 10000) {
    try {
        return await fetchJSON(url, timeout);
    } catch (e) {
        console.error(`[API Error] ${url}: ${e.message}`);
        return null;
    }
}

// ─── Data Fetchers (Kraken primary — works from Render/cloud without issues) ───

async function fetchBtcPrice() {
    const sources = [
        // 1. Kraken — no API key, no rate limits, works everywhere
        async () => {
            const d = await safeFetch('https://api.kraken.com/0/public/Ticker?pair=XBTUSD');
            if (d && d.result && d.result.XXBTZUSD) {
                const t = d.result.XXBTZUSD;
                const price = parseFloat(t.c[0]); // last trade
                const vol = parseFloat(t.v[1]) * parseFloat(t.p[1]); // 24h vol in USD
                const open = parseFloat(t.o);
                const change = open > 0 ? ((price / open) - 1) * 100 : 0;
                console.log(`  [Price] Kraken: $${price.toFixed(0)}`);
                return { current: price, volume_24h: vol, market_cap: price * 19820000, change_24h: +change.toFixed(2) };
            }
            return null;
        },
        // 2. Binance
        async () => {
            const d = await safeFetch('https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT');
            if (d && d.lastPrice) {
                const price = parseFloat(d.lastPrice);
                console.log(`  [Price] Binance: $${price.toFixed(0)}`);
                return { current: price, volume_24h: parseFloat(d.quoteVolume || 0), market_cap: price * 19820000, change_24h: parseFloat(d.priceChangePercent || 0) };
            }
            return null;
        },
        // 3. CoinGecko
        async () => {
            const d = await safeFetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_vol=true&include_market_cap=true&include_24hr_change=true');
            if (d && d.bitcoin) {
                console.log(`  [Price] CoinGecko: $${d.bitcoin.usd}`);
                return { current: d.bitcoin.usd || 0, volume_24h: d.bitcoin.usd_24h_vol || 0, market_cap: d.bitcoin.usd_market_cap || 0, change_24h: d.bitcoin.usd_24h_change || 0 };
            }
            return null;
        },
        // 4. Blockchain.info
        async () => {
            const d = await safeFetch('https://blockchain.info/ticker');
            if (d && d.USD) {
                const price = d.USD.last;
                console.log(`  [Price] Blockchain.info: $${price}`);
                return { current: price, volume_24h: 0, market_cap: price * 19820000, change_24h: 0 };
            }
            return null;
        }
    ];
    for (const src of sources) {
        try {
            const result = await src();
            if (result && result.current > 0) return result;
        } catch (e) { /* try next */ }
    }
    console.error('  [Price] ALL SOURCES FAILED');
    return { current: 0, volume_24h: 0, market_cap: 0, change_24h: 0 };
}

async function fetchFearGreed() {
    const data = await safeFetch('https://api.alternative.me/fng/?limit=1');
    if (data && data.data && data.data.length > 0) {
        return {
            value: parseInt(data.data[0].value),
            classification: data.data[0].value_classification || ''
        };
    }
    return { value: 50, classification: 'Neutral' };
}

async function fetchMarketData() {
    // Use hardcoded circulating supply (changes very slowly — ~450 BTC/day)
    return { circulating_supply: 19820000, total_supply: 21000000 };
}

async function fetchGlobalCrypto() {
    // Try CoinGecko for dominance, fallback to estimate
    const data = await safeFetch('https://api.coingecko.com/api/v3/global');
    if (data && data.data) {
        return {
            btc_dominance: data.data.market_cap_percentage?.btc || 56,
            total_market_cap: data.data.total_market_cap?.usd || 0
        };
    }
    return { btc_dominance: 56, total_market_cap: 0 };
}

async function fetchBlockchainInfo() {
    const [hashRate, difficulty] = await Promise.all([
        safeFetch('https://blockchain.info/q/hashrate'),
        safeFetch('https://blockchain.info/q/getdifficulty')
    ]);
    return {
        hash_rate: typeof hashRate === 'number' ? hashRate : 0,
        difficulty: typeof difficulty === 'number' ? difficulty : 0
    };
}

async function fetchFundingRate() {
    // Try Binance, fallback to 0
    const data = await safeFetch('https://fapi.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT&limit=1');
    if (data && Array.isArray(data) && data.length > 0) {
        return parseFloat(data[0].fundingRate || 0) * 100;
    }
    return 0;
}

async function fetchOpenInterest() {
    const data = await safeFetch('https://fapi.binance.com/fapi/v1/openInterest?symbol=BTCUSDT');
    if (data && data.openInterest) return parseFloat(data.openInterest);
    return 0;
}

async function fetchLongShortRatio() {
    const data = await safeFetch('https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=BTCUSDT&period=1h&limit=1');
    if (data && Array.isArray(data) && data.length > 0) {
        return parseFloat(data[0].longShortRatio || 1.0);
    }
    return 1.0;
}

// ─── Historical price cache for accurate calculations ───
let historicalPrices = { prices: [], lastFetch: 0 };

async function fetchHistoricalPrices() {
    const now = Date.now();
    // Refresh every 30 min
    if (historicalPrices.prices.length > 0 && (now - historicalPrices.lastFetch) < 1800000) {
        return historicalPrices.prices;
    }
    const endTime = Date.now();
    const startTime = endTime - 365 * 24 * 60 * 60 * 1000;

    // 1. Try Kraken OHLC (720 candles max at 1440min=1day interval)
    try {
        const since = Math.floor(startTime / 1000);
        const d = await safeFetch(`https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=1440&since=${since}`, 15000);
        if (d && d.result && d.result.XXBTZUSD && d.result.XXBTZUSD.length > 10) {
            const prices = d.result.XXBTZUSD.map(c => parseFloat(c[4])); // close price
            historicalPrices.prices = prices;
            historicalPrices.lastFetch = now;
            console.log(`  [Historical] Kraken: ${prices.length} daily prices loaded`);
            return historicalPrices.prices;
        }
    } catch (e) { console.error('  [Historical] Kraken failed:', e.message); }

    // 2. Try Binance klines
    try {
        const data = await safeFetch(
            `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&startTime=${startTime}&endTime=${endTime}&limit=365`,
            15000
        );
        if (data && Array.isArray(data) && data.length > 10) {
            const prices = data.map(candle => parseFloat(candle[4]));
            historicalPrices.prices = prices;
            historicalPrices.lastFetch = now;
            console.log(`  [Historical] Binance: ${prices.length} daily prices loaded`);
            return historicalPrices.prices;
        }
    } catch (e) { console.error('  [Historical] Binance failed:', e.message); }

    // 3. Fallback: CoinGecko
    const data = await safeFetch(
        'https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=365&interval=daily',
        15000
    );
    if (data && data.prices && data.prices.length > 10) {
        historicalPrices.prices = data.prices.map(([ts, price]) => price);
        historicalPrices.lastFetch = now;
        console.log(`  [Historical] CoinGecko: ${historicalPrices.prices.length} prices`);
    }
    return historicalPrices.prices;
}

// ─── Indicator Calculations (accurate, using historical data) ───

function calcMVRV(price, prices365) {
    // Realized price ≈ average price over last 365 days (weighted proxy)
    // True MVRV uses UTXO-weighted avg, but 365d average is a good free approximation
    if (!prices365 || prices365.length < 30) {
        return { mvrv: 1.0, realizedPrice: price };
    }
    const sum = prices365.reduce((a, b) => a + b, 0);
    const realizedPrice = Math.round(sum / prices365.length);
    const mvrv = realizedPrice > 0 ? +(price / realizedPrice).toFixed(2) : 1.0;
    return { mvrv, realizedPrice };
}

function calcPuellMultiple(price, prices365) {
    // Puell = daily miner revenue / 365-day avg daily miner revenue
    const dailyIssuanceBtc = 3.125 * 144; // ~450 BTC/day post-2024 halving
    const dailyRevenue = dailyIssuanceBtc * price;
    if (!prices365 || prices365.length < 30) return 1.0;
    const avgPrice = prices365.reduce((a, b) => a + b, 0) / prices365.length;
    const avgDailyRevenue = dailyIssuanceBtc * avgPrice;
    return avgDailyRevenue > 0 ? +(dailyRevenue / avgDailyRevenue).toFixed(2) : 1.0;
}

function calcStockToFlow(circulatingSupply) {
    const circulating = circulatingSupply || 19820000;
    // Use blended annual issuance (accounts for halving transition year)
    // The original dashboard uses ~328K annual flow, giving S2F ~60
    const annualIssuance = 328500; // blended rate for halving transition period
    const s2f = +(circulating / annualIssuance).toFixed(1);
    // S2F model price: calibrated to match standard predictions
    // ln(price) = 3.21 * ln(S2F) - 1.23
    const modelPrice = Math.round(Math.exp(3.21 * Math.log(s2f) - 1.23));
    return { s2f, modelPrice };
}

function calcDifficultyRibbon(difficulty) {
    const diffT = difficulty > 0 ? +(difficulty / 1e12).toFixed(2) : 0;
    return { diffT, compression: diffT > 80 };
}

function calcRSI(prices) {
    // True RSI(14) from daily close prices
    if (!prices || prices.length < 16) return 50;
    // Use last 15 prices (14 changes)
    const recent = prices.slice(-15);
    let gains = 0, losses = 0;
    for (let i = 1; i < recent.length; i++) {
        const change = recent[i] - recent[i - 1];
        if (change > 0) gains += change;
        else losses += Math.abs(change);
    }
    const avgGain = gains / 14;
    const avgLoss = losses / 14;
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    const rsi = 100 - (100 / (1 + rs));
    return +rsi.toFixed(1);
}

function calcMA200Position(price, prices365) {
    // True MA200 from actual 200 daily prices
    if (!prices365 || prices365.length < 200) {
        // Fallback: use available data
        if (prices365 && prices365.length > 30) {
            const ma = prices365.reduce((a, b) => a + b, 0) / prices365.length;
            return { position: +((price / ma - 1) * 100).toFixed(1), ma200: Math.round(ma) };
        }
        return { position: 0, ma200: price };
    }
    const last200 = prices365.slice(-200);
    const ma200 = Math.round(last200.reduce((a, b) => a + b, 0) / 200);
    const position = ma200 > 0 ? +((price / ma200 - 1) * 100).toFixed(1) : 0;
    return { position, ma200 };
}

function calcHalvingCycle() {
    const lastHalving = new Date(2024, 3, 20); // April 2024
    const nextHalving = new Date(2028, 3, 20);
    const now = new Date();
    const totalDays = (nextHalving - lastHalving) / (1000 * 60 * 60 * 24);
    const elapsed = (now - lastHalving) / (1000 * 60 * 60 * 24);
    const remaining = Math.round((nextHalving - now) / (1000 * 60 * 60 * 24));
    return { percent: Math.round((elapsed / totalDays) * 100), remaining };
}

function getSignal(indicator, value) {
    const signals = {
        mvrv: v => v < 0.8 ? 'strong_buy' : v < 1.0 ? 'buy' : v < 2.5 ? 'neutral' : v < 3.5 ? 'sell' : 'strong_sell',
        puell: v => v < 0.5 ? 'strong_buy' : v < 0.65 ? 'buy' : v < 1.5 ? 'neutral' : v < 4.0 ? 'sell' : 'strong_sell',
        s2f_dev: v => v < -50 ? 'strong_buy' : v < -20 ? 'buy' : v < 50 ? 'neutral' : v < 100 ? 'sell' : 'strong_sell',
        fear_greed: v => v < 15 ? 'strong_buy' : v < 30 ? 'buy' : v < 60 ? 'neutral' : v < 80 ? 'sell' : 'strong_sell',
        rsi: v => v < 25 ? 'strong_buy' : v < 40 ? 'buy' : v < 60 ? 'neutral' : v < 75 ? 'sell' : 'strong_sell',
        ma200: v => v < -25 ? 'strong_buy' : v < -10 ? 'buy' : v < 30 ? 'neutral' : v < 60 ? 'sell' : 'strong_sell',
        dxy: v => v < -2 ? 'strong_buy' : v < -0.5 ? 'buy' : v < 0.5 ? 'neutral' : v < 2 ? 'sell' : 'strong_sell',
        halving: v => v < 25 ? 'strong_buy' : v < 50 ? 'buy' : v < 70 ? 'neutral' : v < 85 ? 'sell' : 'strong_sell',
        dominance: v => v > 55 ? 'buy' : v > 45 ? 'neutral' : 'sell',
        funding: v => v < -0.05 ? 'strong_buy' : v < -0.01 ? 'buy' : v < 0.05 ? 'neutral' : v < 0.1 ? 'sell' : 'strong_sell',
        ls_ratio: v => v < 0.8 ? 'buy' : v < 1.3 ? 'neutral' : 'sell',
        difficulty: v => v ? 'strong_buy' : 'neutral',
        hashrate: () => 'neutral',
        sp500: () => 'neutral'
    };
    return (signals[indicator] || (() => 'neutral'))(value);
}

function calcBuyScore(indicators) {
    const signalScores = { strong_buy: 100, buy: 75, neutral: 50, sell: 25, strong_sell: 0 };
    const weights = {
        mvrv_approx: 15, puell_multiple: 8, stock_to_flow: 10,
        difficulty_ribbon: 5, hash_rate: 3, fear_greed: 12,
        rsi: 10, ma_200_position: 10, dxy: 7, sp500: 3,
        halving_cycle: 7, btc_dominance: 3, funding_rate: 4, long_short_ratio: 3
    };

    let totalWeight = 0, weightedSum = 0;
    for (const [key, weight] of Object.entries(weights)) {
        if (indicators[key] && indicators[key].signal) {
            weightedSum += (signalScores[indicators[key].signal] || 50) * weight;
            totalWeight += weight;
        }
    }

    const score = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 50;
    let signal;
    if (score >= 80) signal = 'strong_buy';
    else if (score >= 65) signal = 'buy';
    else if (score >= 35) signal = 'neutral';
    else if (score >= 20) signal = 'sell';
    else signal = 'strong_sell';

    return { score, signal };
}

// ─── Main data assembly (fully independent, no external dashboard dependency) ───
async function fetchAllData() {
    return await fetchAllDataLocal();
}

// Local fallback calculation (used when reference API is down)
async function fetchAllDataLocal() {
    const ts = () => new Date().toLocaleTimeString('ru-RU');

    const [priceData, marketData, globalData, fearGreed, blockchain, funding, oi, lsRatio, prices365] = await Promise.all([
        fetchBtcPrice(),
        fetchMarketData(),
        fetchGlobalCrypto(),
        fetchFearGreed(),
        fetchBlockchainInfo(),
        fetchFundingRate(),
        fetchOpenInterest(),
        fetchLongShortRatio(),
        fetchHistoricalPrices()
    ]);

    const price = priceData.current;

    const { mvrv, realizedPrice } = calcMVRV(price, prices365);
    const puell = calcPuellMultiple(price, prices365);
    const { s2f, modelPrice } = calcStockToFlow(marketData.circulating_supply);
    const { diffT, compression } = calcDifficultyRibbon(blockchain.difficulty);
    const hashRateEHs = blockchain.hash_rate > 1e9
        ? Math.round(blockchain.hash_rate / 1e9)
        : Math.round(blockchain.hash_rate / 1e6);
    const rsi = calcRSI(prices365);
    const { position: ma200Pos } = calcMA200Position(price, prices365);
    const { percent: halvingPct, remaining: halvingDays } = calcHalvingCycle();
    const btcDom = +(globalData.btc_dominance).toFixed(1);
    const s2fDeviation = modelPrice > 0 ? ((price / modelPrice) - 1) * 100 : 0;

    const indicators = {
        mvrv_approx: {
            value: mvrv,
            label: `MVRV\u2248${mvrv}x | \u0420\u0435\u0430\u043b\u0438\u0437.\u0446\u0435\u043d\u0430\u2248$${realizedPrice.toLocaleString()}`,
            signal: getSignal('mvrv', mvrv)
        },
        puell_multiple: { value: puell, label: `${puell}x`, signal: getSignal('puell', puell) },
        stock_to_flow: {
            value: s2f,
            label: `S2F: ${s2f} | \u041c\u043e\u0434\u0435\u043b\u044c: $${modelPrice.toLocaleString()}`,
            signal: getSignal('s2f_dev', s2fDeviation)
        },
        difficulty_ribbon: {
            value: diffT,
            label: `${diffT}T ${compression ? '\ud83d\udfe2 \u0421\u0436\u0430\u0442\u0438\u0435' : '\ud83d\udd34 \u0420\u0430\u0441\u0448\u0438\u0440\u0435\u043d\u0438\u0435'}`,
            signal: getSignal('difficulty', compression), compression
        },
        hash_rate: { value: hashRateEHs, label: `${hashRateEHs} EH/s`, signal: getSignal('hashrate', hashRateEHs) },
        fear_greed: { value: fearGreed.value, label: `${fearGreed.value} - ${fearGreed.classification}`, signal: getSignal('fear_greed', fearGreed.value) },
        rsi: { value: rsi, label: `${rsi}`, signal: getSignal('rsi', rsi) },
        ma_200_position: { value: ma200Pos, label: `${ma200Pos > 0 ? '+' : ''}${ma200Pos}%`, signal: getSignal('ma200', ma200Pos) },
        dxy: { value: 0, label: 'N/A', signal: 'neutral', weekChange: 0 },
        sp500: { value: 0, label: 'N/A', signal: 'neutral', weekChange: 0 },
        halving_cycle: { value: halvingPct, label: `${halvingPct}% (${halvingDays}\u0434 \u0434\u043e \u0445\u0430\u043b\u0432\u0438\u043d\u0433\u0430)`, signal: getSignal('halving', halvingPct) },
        btc_dominance: { value: btcDom, label: `${btcDom}%`, signal: getSignal('dominance', btcDom) },
        funding_rate: { value: +funding.toFixed(3), label: `${funding.toFixed(3)}%`, signal: getSignal('funding', funding) },
        long_short_ratio: { value: +lsRatio.toFixed(2), label: `${lsRatio.toFixed(2)}`, signal: getSignal('ls_ratio', lsRatio) },
        open_interest: { value: oi > 0 ? +(oi * price / 1e9).toFixed(1) : 0, label: oi > 0 ? `$${(oi * price / 1e9).toFixed(1)}B` : '$0B', signal: 'neutral' }
    };

    // Try DXY - use 1mo range to ensure enough data points, then compute 7-day change
    try {
        const dxyData = await safeFetch('https://query1.finance.yahoo.com/v8/finance/chart/DX-Y.NYB?range=1mo&interval=1d', 5000);
        if (dxyData?.chart?.result) {
            const timestamps = dxyData.chart.result[0].timestamp || [];
            const closes = dxyData.chart.result[0].indicators.quote[0].close || [];
            // Build array of [timestamp, close] pairs, filter nulls
            const points = [];
            for (let i = 0; i < timestamps.length; i++) {
                if (closes[i] != null) points.push({ ts: timestamps[i] * 1000, close: closes[i] });
            }
            if (points.length >= 2) {
                const current = points[points.length - 1].close;
                const now = Date.now();
                const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
                // Find the closest data point to 7 days ago
                let weekAgoClose = points[0].close;
                for (const p of points) {
                    if (p.ts <= sevenDaysAgo) weekAgoClose = p.close;
                }
                const change = ((current / weekAgoClose) - 1) * 100;
                indicators.dxy = { value: +current.toFixed(2), label: `${current.toFixed(2)} (${change >= 0 ? '+' : ''}${change.toFixed(2)}% 7\u0434)`, signal: getSignal('dxy', change), weekChange: +change.toFixed(2) };
            }
        }
    } catch (e) { /* ignore */ }

    // Try S&P 500 - use 1mo range to ensure enough data points
    try {
        const spData = await safeFetch('https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?range=1mo&interval=1d', 5000);
        if (spData?.chart?.result) {
            const timestamps = spData.chart.result[0].timestamp || [];
            const closes = spData.chart.result[0].indicators.quote[0].close || [];
            const points = [];
            for (let i = 0; i < timestamps.length; i++) {
                if (closes[i] != null) points.push({ ts: timestamps[i] * 1000, close: closes[i] });
            }
            if (points.length >= 2) {
                const current = points[points.length - 1].close;
                const now = Date.now();
                const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
                let weekAgoClose = points[0].close;
                for (const p of points) {
                    if (p.ts <= sevenDaysAgo) weekAgoClose = p.close;
                }
                const change = ((current / weekAgoClose) - 1) * 100;
                indicators.sp500 = { value: Math.round(current), label: `${Math.round(current)} (${change >= 0 ? '+' : ''}${change.toFixed(2)}% 7\u0434)`, signal: change > 1 ? 'buy' : change < -2 ? 'sell' : 'neutral', weekChange: +change.toFixed(2) };
            }
        }
    } catch (e) { /* ignore */ }

    const { score: buyScore, signal: buySignal } = calcBuyScore(indicators);
    indicators.buy_score = { value: buyScore, signal: buySignal };

    const portfolioValue = PORTFOLIO_BTC * price;
    const pnlUsd = portfolioValue - PORTFOLIO_INVESTED;
    const pnlPct = PORTFOLIO_INVESTED > 0 ? ((portfolioValue / PORTFOLIO_INVESTED) - 1) * 100 : 0;

    const result = {
        price: priceData,
        portfolio: { btc_amount: PORTFOLIO_BTC, avg_price: PORTFOLIO_AVG_PRICE, invested: PORTFOLIO_INVESTED, current_value: Math.round(portfolioValue), pnl_usd: Math.round(pnlUsd), pnl_percent: +pnlPct.toFixed(2) },
        indicators,
        updated_at: new Date().toISOString()
    };

    console.log(`[${ts()}] Local data. BTC=$${price.toLocaleString()}, Score=${buyScore}%`);
    return result;
}

async function fetchHistorical(days = 30) {
    // Fetch Fear & Greed data
    const fgData = await safeFetch(`https://api.alternative.me/fng/?limit=${days}`);
    const fgMap = {};
    if (fgData && fgData.data) {
        for (const item of fgData.data) {
            const date = new Date(parseInt(item.timestamp) * 1000);
            fgMap[date.toISOString().split('T')[0]] = parseInt(item.value);
        }
    }

    const mapToResult = (dateStr, price) => {
        const fg = fgMap[dateStr] || 50;
        return { date: dateStr, price: Math.round(price), buy_score: Math.max(0, Math.min(100, 50 + (50 - fg))), fear_greed: fg, rsi: null };
    };

    // 1. Kraken OHLC
    try {
        const since = Math.floor((Date.now() - days * 86400000) / 1000);
        const d = await safeFetch(`https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=1440&since=${since}`, 15000);
        if (d && d.result && d.result.XXBTZUSD && d.result.XXBTZUSD.length > 0) {
            return d.result.XXBTZUSD.map(c => {
                const dateStr = new Date(c[0] * 1000).toISOString().split('T')[0];
                return mapToResult(dateStr, parseFloat(c[4]));
            });
        }
    } catch (e) { /* next */ }

    // 2. Binance klines
    try {
        const endTime = Date.now();
        const startTime = endTime - days * 86400000;
        const klines = await safeFetch(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&startTime=${startTime}&endTime=${endTime}&limit=${days}`, 15000);
        if (klines && Array.isArray(klines) && klines.length > 0) {
            return klines.map(candle => {
                const dateStr = new Date(candle[0]).toISOString().split('T')[0];
                return mapToResult(dateStr, parseFloat(candle[4]));
            });
        }
    } catch (e) { /* next */ }

    // 3. CoinGecko
    const priceData = await safeFetch(`https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=${days}&interval=daily`);
    if (!priceData || !priceData.prices) return [];
    return priceData.prices.map(([ts, price]) => {
        const dateStr = new Date(ts).toISOString().split('T')[0];
        return mapToResult(dateStr, price);
    });
}

// ─── Routes ───

app.get('/api/all', async (req, res) => {
    const now = Date.now();
    if (!cache.data || (now - cache.lastUpdate) > cache.updateInterval) {
        try {
            cache.data = await fetchAllData();
            cache.lastUpdate = now;
        } catch (e) {
            console.error('Error fetching data:', e);
            if (cache.data) return res.json(cache.data);
            return res.status(500).json({ error: 'Failed to fetch data' });
        }
    }
    res.json(cache.data);
});

app.get('/api/historical', async (req, res) => {
    let days = parseInt(req.query.days) || 30;
    days = Math.min(days, 365);
    const cacheKey = `hist_${days}`;
    const now = Date.now();

    if (!cache.historical[cacheKey] || (now - (cache.historical[`${cacheKey}_ts`] || 0)) > 3600000) {
        try {
            cache.historical[cacheKey] = await fetchHistorical(days);
            cache.historical[`${cacheKey}_ts`] = now;
        } catch (e) {
            console.error('Error fetching historical:', e);
            return res.json({ data: cache.historical[cacheKey] || [] });
        }
    }
    res.json({ data: cache.historical[cacheKey] || [] });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'static', 'index.html'));
});

// ─── Start ───
const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
    console.log('='.repeat(50));
    console.log('  BTC Dashboard v3.5');
    console.log(`  Portfolio: ${PORTFOLIO_BTC} BTC @ $${PORTFOLIO_AVG_PRICE.toLocaleString()}`);
    console.log(`  Invested: $${PORTFOLIO_INVESTED.toLocaleString()}`);
    console.log('='.repeat(50));
    console.log(`  Server: http://localhost:${PORT}`);
    console.log('  Auto-refresh: every 60 seconds');
    console.log('='.repeat(50));
});
