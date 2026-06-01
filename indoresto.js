/**
 * IndoResto — Shared Client Library
 * WebSocket real-time + REST API + offline queue
 * Drop this into any module via <script src="/lib/indoresto.js">
 */

// ────────────────────────────────────────────────
// CONFIG
// ────────────────────────────────────────────────
const INDORESTO_CONFIG = {
  apiBase: window.INDORESTO_API || '/api',
  wsUrl:   window.INDORESTO_WS  || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`,
  restaurantId: window.RESTAURANT_ID || 1,
};

// ────────────────────────────────────────────────
// CURRENCY FORMATTER
// ────────────────────────────────────────────────
const IndoResto = {};

IndoResto.fmt = (amount) =>
  new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 })
    .format(amount)
    .replace('Rp\u00a0', 'Rp ');

IndoResto.fmtShort = (amount) => {
  if (amount >= 1_000_000) return `Rp ${(amount / 1_000_000).toFixed(1)}jt`;
  if (amount >= 1_000)     return `Rp ${Math.round(amount / 1_000)}rb`;
  return IndoResto.fmt(amount);
};

// ────────────────────────────────────────────────
// WEBSOCKET MANAGER (auto-reconnect)
// ────────────────────────────────────────────────
IndoResto.WS = {
  socket: null,
  handlers: {},
  reconnectDelay: 1000,
  maxDelay: 30000,
  _reconnectTimer: null,

  connect() {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    try {
      this.socket = new WebSocket(INDORESTO_CONFIG.wsUrl);
      this.socket.onopen    = () => { this.reconnectDelay = 1000; this._emit('connected'); };
      this.socket.onmessage = (e) => { try { const d = JSON.parse(e.data); this._emit(d.type, d.payload); } catch {} };
      this.socket.onclose   = () => { this._emit('disconnected'); this._scheduleReconnect(); };
      this.socket.onerror   = () => { this.socket.close(); };
    } catch (err) {
      this._scheduleReconnect();
    }
  },

  _scheduleReconnect() {
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxDelay);
  },

  on(event, handler) {
    if (!this.handlers[event]) this.handlers[event] = [];
    this.handlers[event].push(handler);
    return () => this.off(event, handler); // returns unsubscribe fn
  },

  off(event, handler) {
    if (this.handlers[event]) {
      this.handlers[event] = this.handlers[event].filter((h) => h !== handler);
    }
  },

  _emit(event, payload) {
    (this.handlers[event] || []).forEach((h) => h(payload));
    (this.handlers['*'] || []).forEach((h) => h({ event, payload }));
  },

  send(type, payload) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type, payload }));
      return true;
    }
    return false;
  },

  disconnect() {
    clearTimeout(this._reconnectTimer);
    this.socket?.close();
  },
};

// ────────────────────────────────────────────────
// REST API CLIENT
// ────────────────────────────────────────────────
IndoResto.API = {
  async request(method, path, body) {
    const url = `${INDORESTO_CONFIG.apiBase}${path}`;
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  },
  get:    (path)        => IndoResto.API.request('GET',    path),
  post:   (path, body)  => IndoResto.API.request('POST',   path, body),
  patch:  (path, body)  => IndoResto.API.request('PATCH',  path, body),
  delete: (path)        => IndoResto.API.request('DELETE', path),
};

// ────────────────────────────────────────────────
// QUEUE API
// ────────────────────────────────────────────────
IndoResto.Queue = {
  list:   ()       => IndoResto.API.get('/queue'),
  add:    (entry)  => IndoResto.API.post('/queue', entry),
  seat:   (id)     => IndoResto.API.patch(`/queue/${id}`, { status: 'seated' }),
  remove: (id)     => IndoResto.API.delete(`/queue/${id}`),
  notify: (id)     => IndoResto.API.post(`/queue/${id}/notify`),
};

// ────────────────────────────────────────────────
// ORDERS API
// ────────────────────────────────────────────────
IndoResto.Orders = {
  list:       ()         => IndoResto.API.get('/orders'),
  get:        (id)       => IndoResto.API.get(`/orders/${id}`),
  create:     (order)    => IndoResto.API.post('/orders', order),
  updateStatus: (id, status) => IndoResto.API.patch(`/orders/${id}`, { status }),
  updateItemStatus: (orderId, itemId, status) =>
    IndoResto.API.patch(`/orders/${orderId}/items/${itemId}`, { status }),
};

// ────────────────────────────────────────────────
// MENU API
// ────────────────────────────────────────────────
IndoResto.Menu = {
  list:       ()         => IndoResto.API.get('/menu'),
  categories: ()         => IndoResto.API.get('/menu/categories'),
  get:        (id)       => IndoResto.API.get(`/menu/${id}`),
};

// ────────────────────────────────────────────────
// PAYMENTS API (Midtrans)
// ────────────────────────────────────────────────
IndoResto.Payments = {
  /**
   * Creates a Midtrans SNAP token via your backend.
   * Backend calls: POST https://app.midtrans.com/snap/v1/transactions
   */
  createSnapToken: (orderId) =>
    IndoResto.API.post('/payments/snap-token', { order_id: orderId }),

  /**
   * Creates a QRIS charge directly via Midtrans Core API
   * Returns: { qr_string, qr_url, transaction_id, expiry_time }
   */
  createQRIS: (orderId, amount) =>
    IndoResto.API.post('/payments/qris', { order_id: orderId, amount }),

  /**
   * Poll payment status (use sparingly — rely on webhook first)
   * Returns: { transaction_status, fraud_status }
   */
  checkStatus: (transactionId) =>
    IndoResto.API.get(`/payments/status/${transactionId}`),

  /**
   * Mark order as paid manually (EDC/cash confirmation)
   */
  confirmManual: (orderId, method, amount) =>
    IndoResto.API.post('/payments/confirm', { order_id: orderId, method, amount }),

  /**
   * Send receipt via WhatsApp or email
   */
  sendReceipt: (orderId, channel, destination) =>
    IndoResto.API.post(`/payments/${orderId}/receipt`, { channel, destination }),
};

// ────────────────────────────────────────────────
// CUSTOMERS (CRM) API
// ────────────────────────────────────────────────
IndoResto.CRM = {
  lookup:     (phone)     => IndoResto.API.get(`/customers?phone=${encodeURIComponent(phone)}`),
  get:        (id)        => IndoResto.API.get(`/customers/${id}`),
  update:     (id, data)  => IndoResto.API.patch(`/customers/${id}`, data),
  addNote:    (id, note)  => IndoResto.API.post(`/customers/${id}/notes`, { note }),
  sendVoucher:(id, discount) => IndoResto.API.post(`/customers/${id}/voucher`, { discount }),
};

// ────────────────────────────────────────────────
// OFFLINE QUEUE (IndexedDB)
// Saves failed mutations and re-tries on reconnect
// ────────────────────────────────────────────────
IndoResto.Offline = {
  _db: null,

  async init() {
    this._db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('indoresto-offline', 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        ['pending-orders', 'pending-queue', 'pending-payments'].forEach((store) => {
          if (!db.objectStoreNames.contains(store)) {
            db.createObjectStore(store, { keyPath: 'localId', autoIncrement: true });
          }
        });
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror   = () => reject(req.error);
    });
  },

  add(store, record) {
    return new Promise((resolve, reject) => {
      const tx  = this._db.transaction(store, 'readwrite');
      const req = tx.objectStore(store).add({ ...record, queuedAt: Date.now() });
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  },

  getAll(store) {
    return new Promise((resolve, reject) => {
      const tx  = this._db.transaction(store, 'readonly');
      const req = tx.objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  },

  delete(store, key) {
    return new Promise((resolve, reject) => {
      const tx  = this._db.transaction(store, 'readwrite');
      const req = tx.objectStore(store).delete(key);
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error);
    });
  },
};

// ────────────────────────────────────────────────
// NOTIFICATION HELPER
// ────────────────────────────────────────────────
IndoResto.Notify = {
  async request() {
    if (!('Notification' in window)) return false;
    const result = await Notification.requestPermission();
    return result === 'granted';
  },

  show(title, body, opts = {}) {
    if (Notification.permission !== 'granted') return;
    const n = new Notification(title, {
      body,
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-72.png',
      ...opts,
    });
    return n;
  },

  orderReady(tableNum, items) {
    return this.show(
      `🔔 Meja ${tableNum} siap disajikan!`,
      items.map((i) => `${i.qty}× ${i.name}`).join(', '),
      { tag: `ready-${tableNum}`, renotify: true, vibrate: [200, 100, 200] }
    );
  },

  queueTurn(customerName, waitMin) {
    return this.show(
      `📢 Giliran Anda segera, ${customerName}!`,
      `Perkiraan ${waitMin} menit lagi. Mohon segera kembali ke restoran.`,
      { tag: 'queue-turn', renotify: true }
    );
  },
};

// ────────────────────────────────────────────────
// SOUND ALERTS
// ────────────────────────────────────────────────
IndoResto.Sound = {
  _ctx: null,

  _getCtx() {
    if (!this._ctx) this._ctx = new (window.AudioContext || window.webkitAudioContext)();
    return this._ctx;
  },

  _beep(freq, duration, volume = 0.3) {
    try {
      const ctx = this._getCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = freq;
      osc.type = 'sine';
      gain.gain.setValueAtTime(volume, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + duration);
    } catch {}
  },

  orderReady() {
    this._beep(880, 0.15);
    setTimeout(() => this._beep(1100, 0.15), 200);
    setTimeout(() => this._beep(1320, 0.3),  400);
  },

  newOrder() {
    this._beep(660, 0.1);
    setTimeout(() => this._beep(880, 0.2), 150);
  },

  queueCall() {
    for (let i = 0; i < 3; i++) {
      setTimeout(() => this._beep(440, 0.15), i * 300);
    }
  },
};

// ────────────────────────────────────────────────
// SERVICE WORKER REGISTRATION
// ────────────────────────────────────────────────
IndoResto.registerSW = async function () {
  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      console.log('[IndoResto] SW registered', reg.scope);
      return reg;
    } catch (err) {
      console.warn('[IndoResto] SW registration failed', err);
    }
  }
};

// ────────────────────────────────────────────────
// AUTO-INIT
// ────────────────────────────────────────────────
window.IndoResto = IndoResto;

document.addEventListener('DOMContentLoaded', () => {
  IndoResto.registerSW();
  IndoResto.Offline.init().catch(console.warn);
  // Connect WS after user interaction (Safari policy)
  const connectWS = () => { IndoResto.WS.connect(); document.removeEventListener('click', connectWS); };
  document.addEventListener('click', connectWS);
});
