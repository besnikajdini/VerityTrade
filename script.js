// --- Configuration & State ---
const CONFIG = {
    startBalance: 10000,
    updateInterval: 2500, // Slower for realism
    volatility: {
        low: 0.008,
        medium: 0.025,
        high: 0.06
    },
    maintenanceMarginRatio: 0.005, // position is liquidated once equity <= 0.5% of margin
    marginCallThreshold: 0.3 // warn once equity < 30% of margin
};

// Initial State
const initialState = {
    cash: CONFIG.startBalance,
    day: 1,
    positions: {}, // open leveraged positions, keyed by id
    orders: {}, // pending limit/stop/stop-limit orders, keyed by id
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
let tradeTab = 'long'; // 'long' | 'short'
let botStrategy = 'none';
let positionIdCounter = 1;
let orderIdCounter = 1;

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
    updateOrderFormVisibility();
    startSimulation();
    renderAll();
});

// --- Core Logic ---
function loadData() {
    const saved = localStorage.getItem('proTradeData_v2');
    if (saved) {
        store = JSON.parse(saved);
        if (!store.positions) store.positions = {};
        if (!store.orders) store.orders = {};

        positionIdCounter = 1 + Object.keys(store.positions).reduce((max, id) => Math.max(max, parseInt(id.split('_')[1]) || 0), 0);
        orderIdCounter = 1 + Object.keys(store.orders).reduce((max, id) => Math.max(max, parseInt(id.split('_')[1]) || 0), 0);

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

    processPendingOrders();
    processPositions();
    runBot();

    saveData();
    renderAll(true); // true = animate
}

function calculateEquity() {
    let positionsValue = 0;
    Object.values(store.positions).forEach(pos => {
        positionsValue += calcPositionValue(pos, currentPrices[pos.assetId]);
    });
    let reservedMargin = 0;
    Object.values(store.orders).forEach(order => { reservedMargin += order.margin; });
    return store.cash + positionsValue + reservedMargin;
}

// --- Margin & Leverage Helpers ---
function calcRequiredMargin(qty, price, leverage) {
    return (qty * price) / leverage;
}

function calcLiquidationPrice(side, entryPrice, qty, margin) {
    const buffer = (margin * (1 - CONFIG.maintenanceMarginRatio)) / qty;
    return side === 'long' ? entryPrice - buffer : entryPrice + buffer;
}

function calcPnL(position, markPrice) {
    const diff = position.side === 'long' ? (markPrice - position.entryPrice) : (position.entryPrice - markPrice);
    return diff * position.qty;
}

function calcPositionValue(position, markPrice) {
    return position.margin + calcPnL(position, markPrice);
}

function calcMarginRatio(position, markPrice) {
    return calcPositionValue(position, markPrice) / position.margin;
}

// --- Orders ---
// Places a market order (fills immediately) or a pending limit/stop/stop-limit
// order (margin is reserved from cash immediately, like a real broker).
function placeOrder({ assetId, side, orderType, qty, leverage, triggerPrice, limitPrice, tp, sl }) {
    if (!qty || qty <= 0 || isNaN(qty)) return { ok: false, reason: 'invalid-qty' };

    const refPrice = orderType === 'market'
        ? currentPrices[assetId]
        : (orderType === 'stop-limit' ? limitPrice : (triggerPrice || limitPrice));
    if (!refPrice || refPrice <= 0) return { ok: false, reason: 'invalid-price' };

    const margin = calcRequiredMargin(qty, refPrice, leverage);
    if (margin > store.cash + 1e-9) return { ok: false, reason: 'insufficient-funds' };

    if (orderType === 'market') {
        store.cash -= margin;
        openPosition({ assetId, side, qty, price: currentPrices[assetId], leverage, margin, tp, sl });
        return { ok: true };
    }

    store.cash -= margin; // reserve margin for the pending order
    const id = `ord_${orderIdCounter++}`;
    store.orders[id] = {
        id, assetId, side, type: orderType, qty, leverage, margin,
        triggerPrice: triggerPrice || null,
        limitPrice: limitPrice || null,
        stage: orderType === 'stop-limit' ? 'trigger' : 'active',
        tp: tp || null, sl: sl || null,
        createdAt: store.day
    };
    logTx('neutral', `order-${orderType}-${side}`, assetId, triggerPrice || limitPrice, qty);
    return { ok: true };
}

function cancelOrder(id) {
    const order = store.orders[id];
    if (!order) return;
    store.cash += order.margin; // release reserved margin
    delete store.orders[id];
    logTx('neutral', 'order-cancelled', order.assetId, order.triggerPrice || order.limitPrice, order.qty);
    renderAll();
}

// Checks every pending order against the latest prices and fills the ones
// that were touched. Stop-limit orders move through two stages: once the
// stop price is touched they arm, then fill once the limit price is touched.
function processPendingOrders() {
    Object.values(store.orders).forEach(order => {
        const price = currentPrices[order.assetId];
        let shouldFill = false;
        let fillPrice = price;

        if (order.type === 'limit') {
            shouldFill = order.side === 'long' ? price <= order.triggerPrice : price >= order.triggerPrice;
            fillPrice = order.triggerPrice;
        } else if (order.type === 'stop') {
            shouldFill = order.side === 'long' ? price >= order.triggerPrice : price <= order.triggerPrice;
            fillPrice = order.triggerPrice;
        } else if (order.type === 'stop-limit') {
            if (order.stage === 'trigger') {
                const armed = order.side === 'long' ? price >= order.triggerPrice : price <= order.triggerPrice;
                if (armed) order.stage = 'active';
            }
            if (order.stage === 'active') {
                shouldFill = order.side === 'long' ? price <= order.limitPrice : price >= order.limitPrice;
                fillPrice = order.limitPrice;
            }
        }

        if (shouldFill) {
            delete store.orders[order.id];
            openPosition({
                assetId: order.assetId, side: order.side, qty: order.qty,
                price: fillPrice, leverage: order.leverage, margin: order.margin,
                tp: order.tp, sl: order.sl
            });
        }
    });
}

// --- Positions ---
function openPosition({ assetId, side, qty, price, leverage, margin, tp, sl }) {
    const id = `pos_${positionIdCounter++}`;
    store.positions[id] = {
        id, assetId, side, qty, entryPrice: price, leverage, margin,
        liquidationPrice: calcLiquidationPrice(side, price, qty, margin),
        tp: tp || null, sl: sl || null,
        marginWarned: false,
        openedAt: store.day
    };
    logTx(side === 'long' ? 'buy' : 'sell', `open-${side}`, assetId, price, qty);
    return store.positions[id];
}

function closePosition(id, price, reason) {
    const pos = store.positions[id];
    if (!pos) return;

    const pnl = calcPnL(pos, price);
    store.cash += Math.max(0, pos.margin + pnl); // no negative-balance: loss is capped at the margin

    delete store.positions[id];

    const label = reason === 'liquidation' ? 'liquidation' : reason === 'tp' ? 'tp-hit' : reason === 'sl' ? 'sl-hit' : `close-${pos.side}`;
    const variant = reason === 'liquidation' ? 'sell' : reason === 'tp' ? 'buy' : reason === 'sl' ? 'sell' : (pnl >= 0 ? 'buy' : 'sell');
    logTx(variant, label, pos.assetId, price, pos.qty);

    if (reason === 'liquidation') showToast(`Liquidated: ${pos.assetId} ${pos.side.toUpperCase()}`, 'error');
    else if (reason === 'tp') showToast(`Take-Profit hit: ${pos.assetId} ${pos.side.toUpperCase()}`, 'success');
    else if (reason === 'sl') showToast(`Stop-Loss hit: ${pos.assetId} ${pos.side.toUpperCase()}`, 'error');

    return pnl;
}

// Runs every tick: liquidates positions whose equity has collapsed below
// the maintenance margin, warns once on positions nearing that threshold,
// and closes positions whose take-profit/stop-loss price was touched.
function processPositions() {
    Object.values(store.positions).forEach(pos => {
        const price = currentPrices[pos.assetId];
        const ratio = calcMarginRatio(pos, price);

        if (ratio <= CONFIG.maintenanceMarginRatio) {
            closePosition(pos.id, price, 'liquidation');
            return;
        }

        if (ratio < CONFIG.marginCallThreshold) {
            if (!pos.marginWarned) {
                showToast(`Margin call warning: ${pos.assetId} ${pos.side.toUpperCase()} nearing liquidation`, 'error');
                pos.marginWarned = true;
            }
        } else {
            pos.marginWarned = false;
        }

        if (pos.tp) {
            const hit = pos.side === 'long' ? price >= pos.tp : price <= pos.tp;
            if (hit) { closePosition(pos.id, pos.tp, 'tp'); return; }
        }
        if (pos.sl) {
            const hit = pos.side === 'long' ? price <= pos.sl : price >= pos.sl;
            if (hit) { closePosition(pos.id, pos.sl, 'sl'); return; }
        }
    });
}

function logTx(variant, label, symbol, price, qty) {
    store.transactions.unshift({ id: Date.now() + Math.random(), day: store.day, variant, label, symbol, price, qty });
    if (store.transactions.length > 50) store.transactions.pop();
}

function runBot() {
    if (botStrategy === 'none') return;
    const leverage = 1; // conservative — keeps the bot from liquidating itself

    ASSETS.forEach(asset => {
        const id = asset.id;
        const price = currentPrices[id];
        const prev = previousPrices[id];
        if (!prev) return;

        const change = (price - prev) / prev;

        if (botStrategy === 'buy-dip' && change < -0.02) {
            const invest = 500;
            if (store.cash >= invest) {
                store.cash -= invest;
                openPosition({ assetId: id, side: 'long', qty: invest / price, price, leverage, margin: invest });
            }
        } else if (botStrategy === 'momentum') {
            if (change > 0.025) { // Buy breakout
                const invest = 300;
                if (store.cash >= invest) {
                    store.cash -= invest;
                    openPosition({ assetId: id, side: 'long', qty: invest / price, price, leverage, margin: invest });
                }
            } else if (change < -0.02) { // Stop loss: exit bot longs on this asset
                Object.values(store.positions)
                    .filter(p => p.assetId === id && p.side === 'long')
                    .forEach(p => closePosition(p.id, price, 'manual'));
            }
        }
    });
}

// --- UI Rendering ---
function renderAll(animate = false) {
    renderHeader();
    renderMarket(animate);
    renderPositions();
    renderOpenOrders();
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

function renderPositions() {
    const tbody = document.getElementById('positions-list');
    const positions = Object.values(store.positions);

    if (positions.length === 0) {
        tbody.innerHTML = '<tr><td colspan="9" class="empty-state">No Open Positions</td></tr>';
        return;
    }

    tbody.innerHTML = positions.map(pos => {
        const price = currentPrices[pos.assetId] || 0;
        const pnl = calcPnL(pos, price);
        const pnlP = (pnl / pos.margin) * 100;
        const ratio = calcMarginRatio(pos, price);
        const warning = ratio < CONFIG.marginCallThreshold;

        return `
            <tr class="${warning ? 'row-warning' : ''}">
                <td>
                    <div style="font-weight:700">${pos.assetId}</div>
                    <div style="font-size:0.75em; color:var(--text-secondary)">$${price.toFixed(2)}</div>
                </td>
                <td><span class="side-badge side-${pos.side}">${pos.side}</span> <span style="color:var(--text-secondary); font-size:0.8em;">${pos.leverage}x</span></td>
                <td>${pos.qty.toFixed(4)}</td>
                <td>$${pos.entryPrice.toFixed(2)}</td>
                <td>$${pos.margin.toFixed(2)}</td>
                <td class="${pnl >= 0 ? 'text-green' : 'text-red'}">
                    ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}<br><small>(${pnlP.toFixed(1)}%)</small>
                </td>
                <td>$${pos.liquidationPrice.toFixed(2)}${warning ? ' <i class="fas fa-triangle-exclamation" title="Margin call warning" style="color:var(--danger-color)"></i>' : ''}</td>
                <td style="font-size:0.85em;">${pos.tp ? '$' + pos.tp.toFixed(2) : '—'} / ${pos.sl ? '$' + pos.sl.toFixed(2) : '—'}</td>
                <td><button class="btn-close-position" data-id="${pos.id}">Close</button></td>
            </tr>
        `;
    }).join('');

    tbody.querySelectorAll('.btn-close-position').forEach(btn => {
        btn.onclick = () => {
            const pos = store.positions[btn.dataset.id];
            if (!pos) return;
            closePosition(pos.id, currentPrices[pos.assetId], 'manual');
            renderAll();
        };
    });
}

function renderOpenOrders() {
    const tbody = document.getElementById('orders-list');
    const orders = Object.values(store.orders);

    if (orders.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No Open Orders</td></tr>';
        return;
    }

    tbody.innerHTML = orders.map(o => {
        const priceLabel = o.type === 'stop-limit'
            ? `Stop $${o.triggerPrice.toFixed(2)} / Limit $${o.limitPrice.toFixed(2)}`
            : `$${(o.triggerPrice || o.limitPrice).toFixed(2)}`;
        return `
            <tr>
                <td style="font-weight:700">${o.assetId}</td>
                <td style="text-transform:capitalize">${o.type}</td>
                <td><span class="side-badge side-${o.side}">${o.side}</span> <span style="color:var(--text-secondary); font-size:0.8em;">${o.leverage}x</span></td>
                <td>${o.qty.toFixed(4)}</td>
                <td style="font-size:0.85em;">${priceLabel}</td>
                <td>$${o.margin.toFixed(2)}</td>
                <td><button class="btn-cancel-order" data-id="${o.id}">Cancel</button></td>
            </tr>
        `;
    }).join('');

    tbody.querySelectorAll('.btn-cancel-order').forEach(btn => {
        btn.onclick = () => cancelOrder(btn.dataset.id);
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

    updateConfirmButtonLabel();
    updateOrderPreview();
}

// Recomputes position size, required margin and estimated liquidation price
// live as the user edits qty/leverage/order-type/trigger fields.
function updateOrderPreview() {
    const type = document.getElementById('order-type-select').value;
    const qty = parseFloat(document.getElementById('trade-qty').value) || 0;
    const leverage = parseInt(document.getElementById('leverage-slider').value, 10);
    document.getElementById('leverage-value').textContent = leverage + 'x';

    let refPrice = currentPrices[selectedAssetId];
    if (type === 'limit' || type === 'stop') {
        refPrice = parseFloat(document.getElementById('trigger-price').value) || refPrice;
    } else if (type === 'stop-limit') {
        refPrice = parseFloat(document.getElementById('limit-price').value) || refPrice;
    }

    const margin = qty > 0 ? calcRequiredMargin(qty, refPrice, leverage) : 0;
    const liquidation = qty > 0 ? calcLiquidationPrice(tradeTab, refPrice, qty, margin) : null;

    document.getElementById('trade-total').textContent = formatCurrency(qty * refPrice);
    document.getElementById('preview-margin').textContent = formatCurrency(margin);
    document.getElementById('preview-liquidation').textContent = liquidation ? formatCurrency(liquidation) : '—';
}

function updateConfirmButtonLabel() {
    const type = document.getElementById('order-type-select').value;
    const btn = document.getElementById('confirm-trade-btn');
    const sideLabel = tradeTab === 'long' ? 'Long' : 'Short';
    btn.textContent = type === 'market' ? `Open ${sideLabel}` : `Place ${sideLabel} Order`;
    btn.className = tradeTab === 'long' ? 'btn-primary' : 'btn-primary btn-danger';
}

// Shows/hides the trigger & limit price fields based on the selected order type.
function updateOrderFormVisibility() {
    const type = document.getElementById('order-type-select').value;
    const triggerGroup = document.getElementById('trigger-price-group');
    const limitGroup = document.getElementById('limit-price-group');
    const triggerLabel = document.getElementById('trigger-price-label');

    triggerGroup.hidden = type === 'market';
    limitGroup.hidden = type !== 'stop-limit';
    triggerLabel.textContent = type === 'limit' ? 'Limit Price' : 'Stop Price';
}

function handlePlaceOrder() {
    const assetId = selectedAssetId;
    const side = tradeTab;
    const orderType = document.getElementById('order-type-select').value;
    const qty = parseFloat(document.getElementById('trade-qty').value);
    const leverage = parseInt(document.getElementById('leverage-slider').value, 10);
    const triggerPrice = parseFloat(document.getElementById('trigger-price').value) || null;
    const limitPrice = parseFloat(document.getElementById('limit-price').value) || null;
    const tp = parseFloat(document.getElementById('tp-price').value) || null;
    const sl = parseFloat(document.getElementById('sl-price').value) || null;

    if (!qty || qty <= 0) { showToast('Invalid quantity', 'error'); return; }
    if ((orderType === 'limit' || orderType === 'stop') && !triggerPrice) {
        showToast(`Set a ${orderType === 'limit' ? 'limit' : 'stop'} price`, 'error');
        return;
    }
    if (orderType === 'stop-limit' && (!triggerPrice || !limitPrice)) {
        showToast('Set both stop and limit price', 'error');
        return;
    }

    const refPrice = triggerPrice || limitPrice || currentPrices[assetId];
    if (tp) {
        const valid = side === 'long' ? tp > refPrice : tp < refPrice;
        if (!valid) { showToast(`Take-Profit must be ${side === 'long' ? 'above' : 'below'} the entry price`, 'error'); return; }
    }
    if (sl) {
        const valid = side === 'long' ? sl < refPrice : sl > refPrice;
        if (!valid) { showToast(`Stop-Loss must be ${side === 'long' ? 'below' : 'above'} the entry price`, 'error'); return; }
    }

    const result = placeOrder({ assetId, side, orderType, qty, leverage, triggerPrice, limitPrice, tp, sl });

    if (!result.ok) {
        const messages = {
            'insufficient-funds': 'Insufficient funds for required margin',
            'invalid-qty': 'Invalid quantity',
            'invalid-price': 'Invalid price'
        };
        showToast(messages[result.reason] || 'Order rejected', 'error');
        return;
    }

    showToast(orderType === 'market' ? `${side === 'long' ? 'Long' : 'Short'} position opened` : 'Order placed', 'success');
    document.getElementById('trade-qty').value = '';
    document.getElementById('tp-price').value = '';
    document.getElementById('sl-price').value = '';
    renderAll();
}

function renderHistory() {
    const list = document.getElementById('transaction-list');
    list.innerHTML = store.transactions.map(tx => `
        <div class="transaction-item">
            <div>
                <span class="tx-badge tx-${tx.variant}">${tx.label.replace(/-/g, ' ')}</span>
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

    // Long / Short side tabs
    document.querySelectorAll('#side-tabs .tab-btn').forEach(btn => {
        btn.onclick = () => {
            tradeTab = btn.dataset.side;
            document.querySelectorAll('#side-tabs .tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            updateConfirmButtonLabel();
            updateOrderPreview();
        };
    });

    // Positions / Open Orders tabs
    document.querySelectorAll('#positions-orders-tabs .tab-btn').forEach(btn => {
        btn.onclick = () => {
            document.querySelectorAll('#positions-orders-tabs .tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const view = btn.dataset.view;
            document.getElementById('positions-view').hidden = view !== 'positions';
            document.getElementById('orders-view').hidden = view !== 'orders';
        };
    });

    document.getElementById('order-type-select').onchange = () => {
        updateOrderFormVisibility();
        updateConfirmButtonLabel();
        updateOrderPreview();
    };

    ['trade-qty', 'trigger-price', 'limit-price'].forEach(elId => {
        document.getElementById(elId).oninput = updateOrderPreview;
    });
    document.getElementById('leverage-slider').oninput = updateOrderPreview;

    document.getElementById('confirm-trade-btn').onclick = handlePlaceOrder;

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
}
