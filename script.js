// --- Configuration & State ---
const CONFIG = {
    startBalance: 10000,
    updateInterval: 2500, // Slower for realism
    volatility: {
        low: 0.008,
        medium: 0.025,
        high: 0.06
    }
};

// Initial State
const initialState = {
    cash: CONFIG.startBalance,
    day: 1,
    portfolio: {},
    transactions: []
};

// --- Chart Config ---
const TIMEFRAMES = {
    '1m': { seconds: 60, bars: 180 },
    '5m': { seconds: 300, bars: 180 },
    '1h': { seconds: 3600, bars: 168 },
    '1D': { seconds: 86400, bars: 120 }
};

const ASSETS = [
    { id: 'BTC', name: 'Bitcoin', startPrice: 42000, type: 'crypto' },
    { id: 'ETH', name: 'Ethereum', startPrice: 2200, type: 'crypto' },
    { id: 'SOL', name: 'Solana', startPrice: 95, type: 'crypto' },
    { id: 'AAPL', name: 'Apple', startPrice: 185, type: 'stock' },
    { id: 'TSLA', name: 'Tesla', startPrice: 215, type: 'stock' },
    { id: 'NVDA', name: 'Nvidia', startPrice: 550, type: 'stock' },
    { id: 'GOOGL', name: 'Google', startPrice: 140, type: 'stock' },
    { id: 'XAU', name: 'Gold', startPrice: 2050, type: 'commodity' }
];

let store = { ...initialState };
let currentPrices = {};
let previousPrices = {};
let simulationInterval = null;
let currentVolatility = 'medium';
let selectedAssetId = 'BTC';
let tradeTab = 'buy';
let botStrategy = 'none';

// Chart state
const chartState = { timeframe: '1h', type: 'candlestick', showSMA: false, showEMA: false, showVolume: true, smaPeriod: 20, emaPeriod: 20 };
const chartApi = { chart: null, mainSeries: null, volumeSeries: null, smaSeries: null, emaSeries: null };
const assetBarsCache = {};

// --- Init ---
document.addEventListener('DOMContentLoaded', () => {
    loadData();
    // Initialize prices if fresh
    if (Object.keys(currentPrices).length === 0) {
        ASSETS.forEach(a => {
            currentPrices[a.id] = a.startPrice;
            previousPrices[a.id] = a.startPrice; // No change initially
        });
    }

    setupEventListeners();
    initPriceChart();
    startSimulation();
    renderAll();
});

// --- Core Logic ---
function loadData() {
    const saved = localStorage.getItem('proTradeData_v2');
    if (saved) {
        store = JSON.parse(saved);
        // We assume prices are volatile and reset them to start for simplicity 
        // OR we could save prices too. Let's restart prices to keep it simple but keep portfolio.
        ASSETS.forEach(a => {
            currentPrices[a.id] = a.startPrice;
            previousPrices[a.id] = a.startPrice;
        });
    }
}

function saveData() {
    localStorage.setItem('proTradeData_v2', JSON.stringify(store));
}

function startSimulation() {
    if (simulationInterval) clearInterval(simulationInterval);
    simulationInterval = setInterval(nextDay, CONFIG.updateInterval);
}

function nextDay() {
    store.day++;
    
    // Update Prices
    ASSETS.forEach(asset => {
        previousPrices[asset.id] = currentPrices[asset.id];
        
        const vol = CONFIG.volatility[currentVolatility];
        // More realistic random walk with slight upward bias usually, but let's keep it random
        const percentChange = (Math.random() * 2 - 1) * vol; 
        
        // Apply change
        let price = currentPrices[asset.id] * (1 + percentChange);
        if (price < 0.01) price = 0.01;
        
        currentPrices[asset.id] = price;
    });

    runBot();

    saveData();
    renderAll(true); // true = animate
}

function calculateEquity() {
    let assetsCheck = 0;
    for (const [id, data] of Object.entries(store.portfolio)) {
        if (currentPrices[id]) {
            assetsCheck += data.qty * currentPrices[id];
        }
    }
    return store.cash + assetsCheck;
}

// --- Trading ---
function executeTrade() {
    const qtyInput = document.getElementById('trade-qty');
    const qty = parseFloat(qtyInput.value);
    
    if (isNaN(qty) || qty <= 0) {
        showToast('Invalid quantity', 'error');
        return;
    }

    const price = currentPrices[selectedAssetId];
    const cost = price * qty;
    
    if (tradeTab === 'buy') {
        if (store.cash >= cost) {
            store.cash -= cost;
            if (!store.portfolio[selectedAssetId]) store.portfolio[selectedAssetId] = { qty: 0, avgPrice: 0 };
            
            // Recalculate Avg Price
            const oldQty = store.portfolio[selectedAssetId].qty;
            const oldAvg = store.portfolio[selectedAssetId].avgPrice;
            const newQty = oldQty + qty;
            const newAvg = ((oldQty * oldAvg) + cost) / newQty;
            
            store.portfolio[selectedAssetId].qty = newQty;
            store.portfolio[selectedAssetId].avgPrice = newAvg;
            
            logTx('buy', selectedAssetId, price, qty);
            showToast(`Bought ${qty} ${selectedAssetId}`, 'success');
            qtyInput.value = '';
            renderAll();
        } else {
            showToast('Insufficient Funds', 'error');
        }
    } else {
        // Sell
        const currentQty = store.portfolio[selectedAssetId]?.qty || 0;
        if (currentQty >= qty) {
            store.cash += cost;
            store.portfolio[selectedAssetId].qty -= qty;
            
            if (store.portfolio[selectedAssetId].qty < 0.0001) {
                delete store.portfolio[selectedAssetId];
            }
            
            logTx('sell', selectedAssetId, price, qty);
            showToast(`Sold ${qty} ${selectedAssetId}`, 'success');
            qtyInput.value = '';
            renderAll();
        } else {
            showToast('Insufficient Assets', 'error');
        }
    }
}

function logTx(type, symbol, price, qty) {
    store.transactions.unshift({
        id: Date.now(),
        day: store.day,
        type,
        symbol,
        price,
        qty
    });
    if (store.transactions.length > 50) store.transactions.pop();
}

function runBot() {
    if (botStrategy === 'none') return;

    ASSETS.forEach(asset => {
        const id = asset.id;
        const price = currentPrices[id];
        const prev = previousPrices[id];
        if (!prev) return;
        
        const change = (price - prev) / prev;
        
        // Simple logic hooks
        if (botStrategy === 'buy-dip' && change < -0.02) {
            // Buy small amount
            const invest = 500;
            if (store.cash > invest) {
                // Background trade, direct manipulation for speed
                store.cash -= invest;
                if (!store.portfolio[id]) store.portfolio[id] = {qty:0, avgPrice:0};
                let q = store.portfolio[id].qty;
                let a = store.portfolio[id].avgPrice;
                let boughtQty = invest / price;
                store.portfolio[id].avgPrice = ((q*a)+invest) / (q+boughtQty);
                store.portfolio[id].qty += boughtQty;
                logTx('bot-buy', id, price, boughtQty);
                // No toast for bot to avoid spam
            }
        }
        else if (botStrategy === 'momentum') {
            if (change > 0.025) { // Buy breakout
                 const invest = 300;
                 if (store.cash > invest) {
                     store.cash -= invest;
                     if (!store.portfolio[id]) store.portfolio[id] = {qty:0, avgPrice:0};
                     let q = store.portfolio[id].qty;
                     let a = store.portfolio[id].avgPrice;
                     let boughtQty = invest / price;
                     store.portfolio[id].avgPrice = ((q*a)+invest) / (q+boughtQty);
                     store.portfolio[id].qty += boughtQty;
                     logTx('bot-buy', id, price, boughtQty);
                 }
            } else if (change < -0.02 && store.portfolio[id]) { // Stop loss
                const qty = store.portfolio[id].qty;
                if (qty > 0) {
                     store.cash += qty * price;
                     logTx('bot-sell', id, price, qty);
                     delete store.portfolio[id];
                }
            }
        }
    });
}

// --- UI Rendering ---
function renderAll(animate = false) {
    renderHeader();
    renderMarket(animate);
    renderPortfolio();
    renderTradeBox();
    renderHistory();
    if (animate) updateChartLive();
}

function renderHeader() {
    const eq = calculateEquity();
    const pl = eq - CONFIG.startBalance;
    const plP = (pl / CONFIG.startBalance) * 100;
    
    document.getElementById('day-counter').textContent = store.day;
    document.getElementById('total-equity').textContent = formatCurrency(eq);
    
    const plEl = document.getElementById('total-pl');
    plEl.innerHTML = `<span class="${pl >= 0 ? 'text-green' : 'text-red'}">
        ${pl >= 0 ? '+' : ''}${plP.toFixed(2)}%
    </span>`;
    
    document.getElementById('available-cash').textContent = formatCurrency(store.cash);
}

function renderMarket(animate) {
    const list = document.getElementById('market-list');
    // Save scroll position
    const scroll = list.scrollTop;
    
    list.innerHTML = '';
    
    ASSETS.forEach(asset => {
        const id = asset.id;
        const price = currentPrices[id];
        const prev = previousPrices[id];
        const change = (price - prev) / prev * 100;
        
        const el = document.createElement('div');
        el.className = `market-item ${selectedAssetId === id ? 'active' : ''}`;
        el.onclick = () => selectAsset(id);
        
        const flashClass = animate ? (change > 0 ? 'flash-up' : (change < 0 ? 'flash-down' : '')) : '';
        
        el.innerHTML = `
            <div class="asset-info">
                <span class="asset-symbol">${id}</span>
                <span class="asset-name">${asset.name}</span>
            </div>
            <div style="text-align:right" class="${flashClass}">
                ${formatCurrency(price)}
            </div>
            <div style="text-align:right" class="${change >= 0 ? 'text-green' : 'text-red'}">
                ${change >= 0 ? '+' : ''}${change.toFixed(2)}%
            </div>
        `;
        list.appendChild(el);
    });
    
    list.scrollTop = scroll;
}

function renderPortfolio() {
    const tbody = document.getElementById('holdings-list');
    tbody.innerHTML = '';
    
    const holdings = Object.entries(store.portfolio);
    if (holdings.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding: 20px; color: #888;">No Assets Owned</td></tr>';
        return;
    }

    holdings.forEach(([id, data]) => {
        const price = currentPrices[id] || 0;
        const value = data.qty * price;
        const ret = value - (data.qty * data.avgPrice);
        const retP = (data.qty * data.avgPrice) > 0 ? (ret / (data.qty * data.avgPrice) * 100) : 0;
        
        const row = document.createElement('tr');
        row.innerHTML = `
            <td>
                <div style="font-weight:700">${id}</div>
                <div style="font-size:0.75em; color:var(--text-secondary)">$${price.toFixed(2)}</div>
            </td>
            <td>${data.qty.toFixed(4)}</td>
            <td>$${data.avgPrice.toFixed(2)}</td>
            <td>${formatCurrency(value)}</td>
            <td style="text-align:right" class="${ret >= 0 ? 'text-green' : 'text-red'}">
                ${ret >= 0 ? '+' : ''}${Math.abs(ret).toFixed(2)} <br>
                <small>(${retP.toFixed(2)}%)</small>
            </td>
        `;
        row.onclick = () => { selectAsset(id); };
        row.style.cursor = 'pointer';
        tbody.appendChild(row);
    });
}

function renderTradeBox() {
    const price = currentPrices[selectedAssetId];
    
    // Select
    const select = document.getElementById('trade-asset-select');
    if (select.children.length === 0) {
        select.innerHTML = ASSETS.map(a => `<option value="${a.id}">${a.name} (${a.id})</option>`).join('');
        select.onchange = (e) => selectAsset(e.target.value);
    }
    select.value = selectedAssetId;
    
    // Price
    document.getElementById('trade-price-display').textContent = formatCurrency(price);

    // Keep action button style in sync with selected tab.
    const confirmBtn = document.getElementById('confirm-trade-btn');
    confirmBtn.textContent = tradeTab === 'buy' ? 'Execute Buy' : 'Execute Sell';
    confirmBtn.className = tradeTab === 'buy' ? 'btn-primary' : 'btn-primary btn-danger';
    
    // Total calculation
    updateTotal();
}

function updateTotal() {
    const qty = parseFloat(document.getElementById('trade-qty').value) || 0;
    const total = qty * currentPrices[selectedAssetId];
    document.getElementById('trade-total').textContent = formatCurrency(total);
}

function renderHistory() {
    const list = document.getElementById('transaction-list');
    list.innerHTML = store.transactions.map(tx => `
        <div class="transaction-item">
            <div>
                <span class="tx-badge ${tx.type.includes('buy') ? 'tx-buy' : 'tx-sell'}">${tx.type}</span>
                <span style="font-weight:600; margin-left: 5px;">${tx.symbol}</span>
            </div>
            <div style="text-align:right">
                <div>${tx.qty.toFixed(4)} @ $${tx.price.toFixed(2)}</div>
                <div style="font-size:0.75rem; color:var(--text-secondary)">Day ${tx.day}</div>
            </div>
        </div>
    `).join('');
}

// --- Charting (lightweight-charts) ---

// Generates a realistic synthetic OHLCV history for an asset/timeframe:
// a random walk with slight drift, volatility scaled to the bar size,
// wicks derived from the open/close move, and volume shaped by move size.
// The series is anchored so its last close matches the asset's live price.
function generateBars(assetId, timeframe) {
    const tf = TIMEFRAMES[timeframe];
    const asset = ASSETS.find(a => a.id === assetId);
    const endPrice = currentPrices[assetId] || asset.startPrice;
    const dailyVol = CONFIG.volatility[currentVolatility];
    const barVol = dailyVol * Math.sqrt(tf.seconds / 86400);
    const drift = 0.00004;

    // Walk backward from the live price to build a plausible history, oldest last.
    const closesDesc = [endPrice];
    let price = endPrice;
    for (let i = 1; i < tf.bars; i++) {
        const change = (Math.random() * 2 - 1) * barVol + drift;
        price = price / (1 + change);
        if (price < 0.01) price = 0.01;
        closesDesc.push(price);
    }
    const closes = closesDesc.reverse(); // oldest -> newest, last === endPrice

    const now = Math.floor(Date.now() / 1000);
    const lastTime = Math.floor(now / tf.seconds) * tf.seconds;

    const bars = [];
    let prevClose = closes[0] * (1 + (Math.random() * 2 - 1) * barVol * 0.5);
    closes.forEach((close, i) => {
        const time = lastTime - (closes.length - 1 - i) * tf.seconds;
        const open = prevClose;
        const wick = (Math.abs(close - open) * (0.3 + Math.random() * 0.7)) + (open * barVol * 0.3);
        const high = Math.max(open, close) + wick * Math.random();
        const low = Math.max(0.01, Math.min(open, close) - wick * Math.random());
        const baseVolume = asset.type === 'crypto' ? 40 : 400;
        const volume = Math.round(baseVolume * (1 + Math.abs(close - open) / open / barVol) * (0.5 + Math.random()));
        bars.push({ time, open, high, low, close, volume });
        prevClose = close;
    });
    return bars;
}

function getBars(assetId, timeframe) {
    const key = `${assetId}_${timeframe}`;
    if (!assetBarsCache[key]) assetBarsCache[key] = generateBars(assetId, timeframe);
    return assetBarsCache[key];
}

// Appends a new bar (on timeframe boundary) or updates the currently forming
// one using the real simulated price — ties the chart to the live simulation.
function pushLiveBar(assetId) {
    const timeframe = chartState.timeframe;
    const key = `${assetId}_${timeframe}`;
    const bars = assetBarsCache[key];
    if (!bars || bars.length === 0) return null;

    const tf = TIMEFRAMES[timeframe];
    const last = bars[bars.length - 1];
    const close = currentPrices[assetId];
    const barTime = Math.floor(Date.now() / 1000 / tf.seconds) * tf.seconds;

    if (barTime > last.time) {
        const open = last.close;
        const bar = {
            time: barTime,
            open,
            high: Math.max(open, close),
            low: Math.min(open, close),
            close,
            volume: Math.round(Math.abs(close - open) / open * 100000) + 5
        };
        bars.push(bar);
        return bar;
    }

    last.high = Math.max(last.high, close);
    last.low = Math.min(last.low, close);
    last.close = close;
    last.volume += Math.round(Math.abs(close - last.open) / last.open * 1000) + 1;
    return last;
}

function computeSMA(bars, period) {
    const result = [];
    for (let i = period - 1; i < bars.length; i++) {
        let sum = 0;
        for (let j = i - period + 1; j <= i; j++) sum += bars[j].close;
        result.push({ time: bars[i].time, value: sum / period });
    }
    return result;
}

function computeEMA(bars, period) {
    const result = [];
    const k = 2 / (period + 1);
    let emaPrev;
    bars.forEach((bar, i) => {
        emaPrev = i === 0 ? bar.close : (bar.close * k + emaPrev * (1 - k));
        if (i >= period - 1) result.push({ time: bar.time, value: emaPrev });
    });
    return result;
}

function volumeColor(bar) {
    return bar.close >= bar.open ? 'rgba(47, 107, 79, 0.5)' : 'rgba(155, 59, 52, 0.5)';
}

function initPriceChart() {
    const container = document.getElementById('price-chart');
    chartApi.chart = LightweightCharts.createChart(container, {
        layout: { background: { color: 'transparent' }, textColor: '#6b645c', fontFamily: 'Inter, sans-serif' },
        grid: {
            vertLines: { color: 'rgba(28,25,23,0.06)' },
            horzLines: { color: 'rgba(28,25,23,0.06)' }
        },
        rightPriceScale: { borderColor: 'rgba(28,25,23,0.1)' },
        timeScale: { borderColor: 'rgba(28,25,23,0.1)', timeVisible: true, secondsVisible: false },
        crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
        autoSize: true
    });

    chartApi.volumeSeries = chartApi.chart.addSeries(LightweightCharts.HistogramSeries, {
        priceFormat: { type: 'volume' },
        priceScaleId: 'volume-scale'
    });
    chartApi.chart.priceScale('volume-scale').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

    setChartType(chartState.type, true);
    chartApi.chart.subscribeCrosshairMove(handleCrosshairMove);
    loadChartData();
}

function setChartType(type, silent) {
    if (chartApi.mainSeries) {
        chartApi.chart.removeSeries(chartApi.mainSeries);
        chartApi.mainSeries = null;
    }
    const upColor = '#2f6b4f', downColor = '#9b3b34';
    if (type === 'candlestick') {
        chartApi.mainSeries = chartApi.chart.addSeries(LightweightCharts.CandlestickSeries, {
            upColor, downColor, borderUpColor: upColor, borderDownColor: downColor,
            wickUpColor: upColor, wickDownColor: downColor
        });
    } else if (type === 'line') {
        chartApi.mainSeries = chartApi.chart.addSeries(LightweightCharts.LineSeries, { color: '#a16207', lineWidth: 2 });
    } else {
        chartApi.mainSeries = chartApi.chart.addSeries(LightweightCharts.AreaSeries, {
            lineColor: '#a16207', topColor: 'rgba(161,98,7,0.28)', bottomColor: 'rgba(161,98,7,0.02)'
        });
    }
    chartState.type = type;
    if (!silent) loadChartData();
}

function loadChartData() {
    const bars = getBars(selectedAssetId, chartState.timeframe);

    chartApi.mainSeries.setData(chartState.type === 'candlestick'
        ? bars.map(b => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close }))
        : bars.map(b => ({ time: b.time, value: b.close })));

    chartApi.volumeSeries.setData(bars.map(b => ({ time: b.time, value: b.volume, color: volumeColor(b) })));

    updateIndicators();
    updateChartLegend(bars[bars.length - 1]);
    chartApi.chart.timeScale().fitContent();
}

function updateIndicators() {
    const bars = getBars(selectedAssetId, chartState.timeframe);

    if (chartState.showSMA) {
        if (!chartApi.smaSeries) {
            chartApi.smaSeries = chartApi.chart.addSeries(LightweightCharts.LineSeries, { color: '#a16207', lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false });
        }
        chartApi.smaSeries.setData(computeSMA(bars, chartState.smaPeriod));
    } else if (chartApi.smaSeries) {
        chartApi.chart.removeSeries(chartApi.smaSeries);
        chartApi.smaSeries = null;
    }

    if (chartState.showEMA) {
        if (!chartApi.emaSeries) {
            chartApi.emaSeries = chartApi.chart.addSeries(LightweightCharts.LineSeries, { color: '#1c1917', lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false });
        }
        chartApi.emaSeries.setData(computeEMA(bars, chartState.emaPeriod));
    } else if (chartApi.emaSeries) {
        chartApi.chart.removeSeries(chartApi.emaSeries);
        chartApi.emaSeries = null;
    }
}

function switchTimeframe(tf) {
    chartState.timeframe = tf;
    document.querySelectorAll('#timeframe-group .chart-btn').forEach(b => b.classList.toggle('active', b.dataset.timeframe === tf));
    loadChartData();
}

// Called every simulation tick: pushes the live price into the chart
// without resetting zoom/pan (unlike a full loadChartData reload).
function updateChartLive() {
    if (!chartApi.chart || !chartApi.mainSeries) return;
    const bar = pushLiveBar(selectedAssetId);
    if (!bar) return;

    chartApi.mainSeries.update(chartState.type === 'candlestick'
        ? { time: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close }
        : { time: bar.time, value: bar.close });
    chartApi.volumeSeries.update({ time: bar.time, value: bar.volume, color: volumeColor(bar) });

    if (chartState.showSMA || chartState.showEMA) updateIndicators();
    updateChartLegend(bar);
}

function handleCrosshairMove(param) {
    if (!param || !param.time || !param.seriesData || !chartApi.mainSeries || !param.seriesData.get(chartApi.mainSeries)) {
        const bars = getBars(selectedAssetId, chartState.timeframe);
        updateChartLegend(bars[bars.length - 1]);
        return;
    }
    const data = param.seriesData.get(chartApi.mainSeries);
    updateChartLegend(chartState.type === 'candlestick'
        ? data
        : { open: data.value, high: data.value, low: data.value, close: data.value });
}

function updateChartLegend(bar) {
    if (!bar) return;
    const asset = ASSETS.find(a => a.id === selectedAssetId);
    const positive = bar.close >= bar.open;
    document.getElementById('chart-legend').innerHTML = `
        <strong>${asset.name} (${selectedAssetId})</strong>
        <span>O <b>${bar.open.toFixed(2)}</b></span>
        <span>H <b>${bar.high.toFixed(2)}</b></span>
        <span>L <b>${bar.low.toFixed(2)}</b></span>
        <span class="${positive ? 'text-green' : 'text-red'}">C <b>${bar.close.toFixed(2)}</b></span>
    `;
}

// --- Interaction Helpers ---
function showToast(msg, type = 'success') {
    const c = document.getElementById('toast-container');
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    const icon = type === 'success' ? 'fa-check-circle' : 'fa-exclamation-circle';
    t.innerHTML = `<i class="fas ${icon}"></i> <span>${msg}</span>`;
    c.appendChild(t);
    
    // Sound (Simple tone) (Browser requires interaction first, often blocked, skipping for simple implementation)
    
    setTimeout(() => {
        t.style.animation = 'fadeOut 0.3s forwards';
        setTimeout(() => c.removeChild(t), 300);
    }, 3000);
}

function selectAsset(id) {
    selectedAssetId = id;
    renderAll();
    if (chartApi.chart) loadChartData();
}

function formatCurrency(num) {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(num);
}

function setupEventListeners() {
    document.getElementById('reset-btn').onclick = () => {
        if (confirm("Reset everything?")) {
            localStorage.removeItem('proTradeData_v2');
            location.reload();
        }
    };
    
    document.getElementById('risk-level').onchange = (e) => {
        currentVolatility = e.target.value;
    };
    
    // Tabs
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.onclick = () => {
             tradeTab = btn.dataset.tab;
             document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
             btn.classList.add('active');
             
             const cBtn = document.getElementById('confirm-trade-btn');
             cBtn.textContent = tradeTab === 'buy' ? 'Execute Buy' : 'Execute Sell';
             cBtn.className = tradeTab === 'buy' ? 'btn-primary' : 'btn-primary btn-danger';
        };
    });
    
    document.getElementById('trade-qty').oninput = updateTotal;
    document.getElementById('confirm-trade-btn').onclick = executeTrade;

    // Chart toolbar
    document.querySelectorAll('#timeframe-group .chart-btn').forEach(btn => {
        btn.onclick = () => switchTimeframe(btn.dataset.timeframe);
    });
    document.querySelectorAll('#chart-type-group .chart-btn').forEach(btn => {
        btn.onclick = () => {
            document.querySelectorAll('#chart-type-group .chart-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            setChartType(btn.dataset.charttype);
        };
    });
    document.getElementById('toggle-sma').onchange = (e) => {
        chartState.showSMA = e.target.checked;
        updateIndicators();
    };
    document.getElementById('toggle-ema').onchange = (e) => {
        chartState.showEMA = e.target.checked;
        updateIndicators();
    };
    document.getElementById('toggle-volume').onchange = (e) => {
        chartState.showVolume = e.target.checked;
        chartApi.volumeSeries.applyOptions({ visible: e.target.checked });
    };

    document.getElementById('strategy-select').onchange = (e) => {
        botStrategy = e.target.value;
        const s = document.getElementById('bot-status');
        if (botStrategy === 'none') {
            s.innerHTML = '● Bot Inactive';
            s.style.color = 'var(--text-secondary)';
        } else {
            s.innerHTML = '● Bot Active & Trading';
            s.style.color = 'var(--success-color)';
        }
    };
}
