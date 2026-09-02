// --- Configuration & State ---
const CONFIG = {
    startBalance: 10000,
    updateInterval: 2500, // Slower for realism
    historyMaxSize: 50,
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
    transactions: [],
    portfolioValueHistory: [CONFIG.startBalance], // Start with initial balance
    dayHistory: [1]
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
let chartInstance = null; // Store context/data for custom chart

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
    initChartInteraction();
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
    
    // Record History
    const equity = calculateEquity();
    store.portfolioValueHistory.push(equity);
    store.dayHistory.push(store.day);
    
    // Trim History for performance
    if (store.portfolioValueHistory.length > 60) {
        store.portfolioValueHistory.shift();
        store.dayHistory.shift();
    }

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
    renderChart();
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

// --- Charting ---
function renderChart() {
    const canvas = document.getElementById('portfolio-chart');
    const ctx = canvas.getContext('2d');
    
    // Resize handling
    const container = canvas.parentElement;
    canvas.width = container.offsetWidth;
    canvas.height = container.offsetHeight || 300;
    
    const w = canvas.width;
    const h = canvas.height;
    const pad = 20;
    
    ctx.clearRect(0,0,w,h);
    
    const data = store.portfolioValueHistory;
    if (data.length < 2) return;
    
    const min = Math.min(...data) * 0.99;
    const max = Math.max(...data) * 1.01;
    const range = max - min;
    
    // Color (light theme only)
    const color = '#3b82f6';
    
    // Path
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    
    const getX = (i) => (i / (data.length - 1)) * w;
    const getY = (v) => h - ((v - min) / range) * (h - pad*2) - pad;
    
    data.forEach((val, i) => {
        if (i === 0) ctx.moveTo(getX(i), getY(val));
        else ctx.lineTo(getX(i), getY(val));
    });
    ctx.stroke();
    
    // Gradient fill
    // We need to close the path for fill
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, 'rgba(59, 130, 246, 0.2)');
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = grad;
    ctx.fill();
}

function initChartInteraction() {
    const canvas = document.getElementById('portfolio-chart');
    const tooltip = document.getElementById('chart-tooltip');
    
    canvas.addEventListener('mousemove', (e) => {
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const w = canvas.width;
        
        const data = store.portfolioValueHistory;
        if (data.length < 2) return;
        
        // Find closest index
        const index = Math.round((x / w) * (data.length - 1));
        if (index >= 0 && index < data.length) {
            const val = data[index];
            const day = store.dayHistory[index];
            
            tooltip.style.opacity = 1;
            tooltip.style.left = `${e.clientX - rect.left}px`;
            tooltip.style.top = `${e.clientY - rect.top}px`;
            tooltip.innerHTML = `Day ${day}<br><strong>${formatCurrency(val)}</strong>`;
        }
    });
    
    canvas.addEventListener('mouseleave', () => {
        tooltip.style.opacity = 0;
    });
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
    
    window.onresize = renderChart;
}
