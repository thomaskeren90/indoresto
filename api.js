/**
 * IndoResto — Backend API
 * Cloudflare Workers (wrangler) OR Node.js + Express
 *
 * Deploy:
 *   Cloudflare Workers: wrangler deploy
 *   Node.js:            node server.js
 *
 * Environment variables needed (wrangler.toml or .env):
 *   DATABASE_URL          — PostgreSQL connection string
 *   MIDTRANS_SERVER_KEY   — Midtrans server key (production)
 *   MIDTRANS_CLIENT_KEY   — Midtrans client key
 *   MIDTRANS_BASE_URL     — https://app.midtrans.com (prod) or https://app.sandbox.midtrans.com
 *   WA_TOKEN              — WhatsApp Cloud API access token
 *   WA_PHONE_ID           — WhatsApp phone number ID
 *   JWT_SECRET            — JWT signing secret
 */

// ─────────────────────────────────────────────────────────────────
// ROUTER (works for both CF Workers fetch handler & Express)
// ─────────────────────────────────────────────────────────────────
const routes = [];
const route = (method, path, ...handlers) => routes.push({ method, path, handlers });

// ─────────────────────────────────────────────────────────────────
// MIDDLEWARE HELPERS
// ─────────────────────────────────────────────────────────────────
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });

const err = (msg, status = 400) => json({ error: msg }, status);

// ─────────────────────────────────────────────────────────────────
// ── MODULE 1: QUEUE ──
// ─────────────────────────────────────────────────────────────────

// GET /api/queue — list active queue entries
route('GET', '/api/queue', async (req, env) => {
  const rows = await env.DB.prepare(
    `SELECT q.*, c.name, c.phone, c.total_visits
     FROM queue q
     JOIN customers c ON c.id = q.customer_id
     WHERE q.status = 'waiting'
     ORDER BY q.joined_at ASC`
  ).all();
  return json(rows);
});

// POST /api/queue — add customer to queue
route('POST', '/api/queue', async (req, env) => {
  const body = await req.json();
  const { name, phone, party_size, wa_notify } = body;
  if (!name || !party_size) return err('name and party_size required');

  // Upsert customer by phone
  let customer = await env.DB.prepare(
    `SELECT id FROM customers WHERE phone = ?`
  ).bind(phone).first();

  if (!customer) {
    const res = await env.DB.prepare(
      `INSERT INTO customers (name, phone, total_visits, created_at) VALUES (?, ?, 0, CURRENT_TIMESTAMP)`
    ).bind(name, phone).run();
    customer = { id: res.meta.last_row_id };
  }

  const entry = await env.DB.prepare(
    `INSERT INTO queue (customer_id, party_size, status, wa_notify, joined_at)
     VALUES (?, ?, 'waiting', ?, CURRENT_TIMESTAMP)
     RETURNING *`
  ).bind(customer.id, party_size, wa_notify ? 1 : 0).first();

  return json(entry, 201);
});

// PATCH /api/queue/:id — seat or remove
route('PATCH', '/api/queue/:id', async (req, env, params) => {
  const body  = await req.json();
  const { status } = body; // 'seated' | 'cancelled'
  await env.DB.prepare(
    `UPDATE queue SET status = ?, seated_at = CASE WHEN ? = 'seated' THEN CURRENT_TIMESTAMP ELSE NULL END WHERE id = ?`
  ).bind(status, status, params.id).run();
  return json({ ok: true });
});

// POST /api/queue/:id/notify — send WA message
route('POST', '/api/queue/:id/notify', async (req, env, params) => {
  const entry = await env.DB.prepare(
    `SELECT q.*, c.name, c.phone FROM queue q JOIN customers c ON c.id = q.customer_id WHERE q.id = ?`
  ).bind(params.id).first();
  if (!entry) return err('Not found', 404);

  await sendWhatsApp(env, entry.phone, {
    type: 'template',
    template: {
      name: 'queue_reminder',
      language: { code: 'id' },
      components: [{
        type: 'body',
        parameters: [
          { type: 'text', text: entry.name },
          { type: 'text', text: '5' },
        ],
      }],
    },
  });

  return json({ ok: true, phone: entry.phone });
});

// ─────────────────────────────────────────────────────────────────
// ── MODULE 2: MENU ──
// ─────────────────────────────────────────────────────────────────

route('GET', '/api/menu', async (req, env) => {
  const items = await env.DB.prepare(
    `SELECT * FROM menu_items WHERE available = 1 ORDER BY category, name_id`
  ).all();
  return json(items);
});

route('GET', '/api/menu/categories', async (req, env) => {
  const cats = await env.DB.prepare(
    `SELECT DISTINCT category FROM menu_items WHERE available = 1`
  ).all();
  return json(cats.map((r) => r.category));
});

// ─────────────────────────────────────────────────────────────────
// ── MODULE 3 & 4: ORDERS ──
// ─────────────────────────────────────────────────────────────────

route('GET', '/api/orders', async (req, env) => {
  const url    = new URL(req.url);
  const status = url.searchParams.get('status') || 'active';
  const query  = status === 'active'
    ? `SELECT o.*, t.table_number, c.name as customer_name, c.phone, c.total_visits
       FROM orders o
       JOIN tables t ON t.id = o.table_id
       LEFT JOIN customers c ON c.id = o.customer_id
       WHERE o.status NOT IN ('closed', 'cancelled')
       ORDER BY o.created_at DESC`
    : `SELECT o.*, t.table_number FROM orders o
       JOIN tables t ON t.id = o.table_id
       ORDER BY o.created_at DESC LIMIT 50`;
  const rows = await env.DB.prepare(query).all();

  // Attach items to each order
  const orderIds = rows.map((r) => r.id);
  if (orderIds.length > 0) {
    const items = await env.DB.prepare(
      `SELECT oi.*, m.name_id, m.name_en, m.price, m.emoji
       FROM order_items oi JOIN menu_items m ON m.id = oi.menu_item_id
       WHERE oi.order_id IN (${orderIds.join(',')})
       ORDER BY oi.created_at`
    ).all();
    const itemMap = {};
    items.forEach((item) => {
      if (!itemMap[item.order_id]) itemMap[item.order_id] = [];
      itemMap[item.order_id].push(item);
    });
    rows.forEach((order) => { order.items = itemMap[order.id] || []; });
  }

  return json(rows);
});

route('POST', '/api/orders', async (req, env) => {
  const body = await req.json();
  const { table_id, customer_id, items } = body;
  if (!table_id || !items?.length) return err('table_id and items required');

  // Calculate total
  const menuIds  = [...new Set(items.map((i) => i.menu_item_id))];
  const menuRows = await env.DB.prepare(
    `SELECT id, price FROM menu_items WHERE id IN (${menuIds.join(',')})`
  ).all();
  const priceMap = Object.fromEntries(menuRows.map((m) => [m.id, m.price]));
  const total    = items.reduce((sum, i) => sum + (priceMap[i.menu_item_id] || 0) * i.quantity, 0);

  // Create order
  const order = await env.DB.prepare(
    `INSERT INTO orders (table_id, customer_id, status, total, created_at)
     VALUES (?, ?, 'open', ?, CURRENT_TIMESTAMP) RETURNING *`
  ).bind(table_id, customer_id || null, total).first();

  // Insert items
  for (const item of items) {
    await env.DB.prepare(
      `INSERT INTO order_items (order_id, menu_item_id, quantity, spice_level, notes, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`
    ).bind(order.id, item.menu_item_id, item.quantity, item.spice_level || null, item.notes || null).run();
  }

  // Broadcast via WebSocket Durable Object
  await broadcastKDS(env, { type: 'NEW_ORDER', payload: { orderId: order.id, tableId: table_id } });

  return json(order, 201);
});

route('PATCH', '/api/orders/:id', async (req, env, params) => {
  const body   = await req.json();
  const { status } = body;
  const closed = status === 'closed' ? `closed_at = CURRENT_TIMESTAMP,` : '';
  await env.DB.prepare(
    `UPDATE orders SET ${closed} status = ? WHERE id = ?`
  ).bind(status, params.id).run();

  await broadcastKDS(env, { type: 'ORDER_STATUS', payload: { orderId: params.id, status } });
  return json({ ok: true });
});

route('PATCH', '/api/orders/:id/items/:itemId', async (req, env, params) => {
  const body = await req.json();
  const { status } = body; // 'preparing' | 'ready' | 'served'
  const extras = {
    preparing: `prep_start = CURRENT_TIMESTAMP,`,
    ready:     `prep_end = CURRENT_TIMESTAMP,`,
    served:    '',
  }[status] || '';

  await env.DB.prepare(
    `UPDATE order_items SET ${extras} status = ? WHERE id = ? AND order_id = ?`
  ).bind(status, params.itemId, params.id).run();

  // If all items ready → notify servers
  if (status === 'ready') {
    const pending = await env.DB.prepare(
      `SELECT COUNT(*) as n FROM order_items WHERE order_id = ? AND status != 'ready' AND status != 'served'`
    ).bind(params.id).first();
    if (pending.n === 0) {
      await env.DB.prepare(`UPDATE orders SET status = 'ready' WHERE id = ?`).bind(params.id).run();
      await broadcastKDS(env, { type: 'ORDER_READY', payload: { orderId: params.id } });
    }
  }

  return json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────
// ── MODULE 5: PAYMENTS (Midtrans) ──
// ─────────────────────────────────────────────────────────────────

// POST /api/payments/snap-token — create Midtrans SNAP token
route('POST', '/api/payments/snap-token', async (req, env) => {
  const { order_id } = await req.json();
  const order = await env.DB.prepare(
    `SELECT o.*, c.name as customer_name, c.phone FROM orders o LEFT JOIN customers c ON c.id = o.customer_id WHERE o.id = ?`
  ).bind(order_id).first();
  if (!order) return err('Order not found', 404);

  const items = await env.DB.prepare(
    `SELECT oi.quantity, m.name_id as name, m.price FROM order_items oi JOIN menu_items m ON m.id = oi.menu_item_id WHERE oi.order_id = ?`
  ).bind(order_id).all();

  const tax = Math.round(order.total * 0.10);
  const svc = Math.round(order.total * 0.05);

  const midtransBody = {
    transaction_details: {
      order_id: `IR-${order_id}-${Date.now()}`,
      gross_amount: order.total + tax + svc,
    },
    item_details: [
      ...items.map((i) => ({ id: String(i.id), price: i.price, quantity: i.quantity, name: i.name })),
      { id: 'tax', price: tax, quantity: 1, name: 'PPN 10%' },
      { id: 'svc', price: svc, quantity: 1, name: 'Service Charge 5%' },
    ],
    customer_details: {
      first_name: order.customer_name || 'Pelanggan',
      phone: order.phone || '',
    },
    enabled_payments: ['qris', 'gopay', 'shopeepay', 'other_qris'],
    callbacks: {
      finish: `${env.BASE_URL}/payment/success?order=${order_id}`,
    },
  };

  const midtransRes = await fetch(`${env.MIDTRANS_BASE_URL}/snap/v1/transactions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${btoa(env.MIDTRANS_SERVER_KEY + ':')}`,
    },
    body: JSON.stringify(midtransBody),
  });

  if (!midtransRes.ok) {
    const errBody = await midtransRes.text();
    return err(`Midtrans error: ${errBody}`, 502);
  }

  const { token, redirect_url } = await midtransRes.json();
  return json({ token, redirect_url, order_id });
});

// POST /api/payments/qris — create QRIS charge (Core API)
route('POST', '/api/payments/qris', async (req, env) => {
  const { order_id, amount } = await req.json();
  const transactionId = `IR-${order_id}-${Date.now()}`;

  const body = {
    payment_type: 'qris',
    transaction_details: { order_id: transactionId, gross_amount: amount },
    qris: { acquirer: 'gopay' }, // or 'airpay shopee'
  };

  const res = await fetch(`${env.MIDTRANS_BASE_URL}/v2/charge`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${btoa(env.MIDTRANS_SERVER_KEY + ':')}`,
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (data.status_code !== '201') return err(`Midtrans: ${data.status_message}`, 502);

  // Save payment record
  await env.DB.prepare(
    `INSERT INTO payments (order_id, method, amount, status, transaction_id, qr_url)
     VALUES (?, 'qris', ?, 'pending', ?, ?)`
  ).bind(order_id, amount, data.transaction_id, data.actions?.[0]?.url || '').run();

  return json({
    transaction_id: data.transaction_id,
    qr_string:      data.qr_string,
    qr_url:         data.actions?.[0]?.url,
    expiry_time:    data.expiry_time,
  });
});

// POST /api/payments/webhook — Midtrans notification webhook
route('POST', '/api/payments/webhook', async (req, env) => {
  const notif = await req.json();
  const { order_id, transaction_status, fraud_status } = notif;

  // Verify signature: SHA512(order_id + status_code + gross_amount + server_key)
  // In production: validate notif.signature_key here

  let paymentStatus;
  if (transaction_status === 'capture' || transaction_status === 'settlement') {
    paymentStatus = fraud_status === 'accept' || !fraud_status ? 'paid' : 'fraud';
  } else if (['cancel', 'deny', 'expire'].includes(transaction_status)) {
    paymentStatus = 'failed';
  } else {
    paymentStatus = 'pending';
  }

  await env.DB.prepare(
    `UPDATE payments SET status = ? WHERE transaction_id = ?`
  ).bind(paymentStatus, notif.transaction_id).run();

  if (paymentStatus === 'paid') {
    // Extract real order_id (format: IR-{id}-{timestamp})
    const realOrderId = order_id.split('-')[1];
    await env.DB.prepare(
      `UPDATE orders SET status = 'closed', closed_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).bind(realOrderId).run();

    // Broadcast payment confirmed
    await broadcastKDS(env, { type: 'PAYMENT_DONE', payload: { orderId: realOrderId } });
  }

  return json({ ok: true });
});

// GET /api/payments/status/:txId
route('GET', '/api/payments/status/:txId', async (req, env, params) => {
  const res = await fetch(`${env.MIDTRANS_BASE_URL}/v2/${params.txId}/status`, {
    headers: { Authorization: `Basic ${btoa(env.MIDTRANS_SERVER_KEY + ':')}` },
  });
  return json(await res.json());
});

// POST /api/payments/confirm — manual confirmation (EDC / cash)
route('POST', '/api/payments/confirm', async (req, env) => {
  const { order_id, method, amount } = await req.json();
  await env.DB.prepare(
    `INSERT INTO payments (order_id, method, amount, status, created_at) VALUES (?, ?, ?, 'paid', CURRENT_TIMESTAMP)`
  ).bind(order_id, method, amount).run();
  await env.DB.prepare(
    `UPDATE orders SET status = 'closed', closed_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).bind(order_id).run();

  // Update customer visits
  await env.DB.prepare(
    `UPDATE customers SET total_visits = total_visits + 1, last_visit = CURRENT_TIMESTAMP
     WHERE id = (SELECT customer_id FROM orders WHERE id = ?)`
  ).bind(order_id).run();

  return json({ ok: true });
});

// POST /api/payments/:id/receipt — send receipt via WA or email
route('POST', '/api/payments/:id/receipt', async (req, env, params) => {
  const { channel, destination } = await req.json();
  const order = await env.DB.prepare(
    `SELECT o.*, SUM(oi.quantity * m.price) as subtotal
     FROM orders o JOIN order_items oi ON oi.order_id = o.id JOIN menu_items m ON m.id = oi.menu_item_id
     WHERE o.id = ?`
  ).bind(params.id).first();

  if (channel === 'whatsapp') {
    await sendWhatsApp(env, destination, {
      type: 'template',
      template: {
        name: 'payment_receipt',
        language: { code: 'id' },
        components: [{
          type: 'body',
          parameters: [
            { type: 'text', text: `#${order.id}` },
            { type: 'text', text: new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR' }).format(order.total) },
          ],
        }],
      },
    });
  }

  return json({ ok: true, channel, destination });
});

// ─────────────────────────────────────────────────────────────────
// ── MODULE 6: CRM ──
// ─────────────────────────────────────────────────────────────────

route('GET', '/api/customers', async (req, env) => {
  const url   = new URL(req.url);
  const phone = url.searchParams.get('phone');
  if (!phone) return err('phone param required');

  const customer = await env.DB.prepare(
    `SELECT * FROM customers WHERE phone LIKE ? LIMIT 1`
  ).bind(`%${phone}%`).first();
  if (!customer) return json(null);

  // Attach favorite items
  const favs = await env.DB.prepare(
    `SELECT m.name_id, COUNT(*) as order_count
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     JOIN menu_items m ON m.id = oi.menu_item_id
     WHERE o.customer_id = ?
     GROUP BY oi.menu_item_id ORDER BY order_count DESC LIMIT 5`
  ).bind(customer.id).all();
  customer.favorites = favs.map((f) => f.name_id);

  return json(customer);
});

route('PATCH', '/api/customers/:id', async (req, env, params) => {
  const body = await req.json();
  const fields = Object.keys(body).map((k) => `${k} = ?`).join(', ');
  await env.DB.prepare(
    `UPDATE customers SET ${fields} WHERE id = ?`
  ).bind(...Object.values(body), params.id).run();
  return json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────

async function sendWhatsApp(env, phone, message) {
  return fetch(`https://graph.facebook.com/v18.0/${env.WA_PHONE_ID}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.WA_TOKEN}`,
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type:    'individual',
      to:                phone,
      ...message,
    }),
  });
}

async function broadcastKDS(env, message) {
  // Cloudflare Durable Objects broadcast
  if (env.KDS_DO) {
    const stub = env.KDS_DO.get(env.KDS_DO.idFromName('kitchen'));
    await stub.fetch('https://kds/broadcast', {
      method: 'POST',
      body: JSON.stringify(message),
    });
  }
}

// ─────────────────────────────────────────────────────────────────
// CLOUDFLARE WORKERS ENTRY POINT
// ─────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url    = new URL(request.url);
    const method = request.method;

    // CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin':  '*',
          'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type,Authorization',
        },
      });
    }

    // Route matching
    for (const { method: m, path, handlers } of routes) {
      if (m !== method) continue;
      const paramNames = [];
      const pattern = path.replace(/:([^/]+)/g, (_, name) => { paramNames.push(name); return '([^/]+)'; });
      const match = url.pathname.match(new RegExp(`^${pattern}$`));
      if (match) {
        const params = Object.fromEntries(paramNames.map((n, i) => [n, match[i + 1]]));
        try {
          return await handlers[handlers.length - 1](request, env, params);
        } catch (e) {
          console.error(e);
          return err('Internal server error', 500);
        }
      }
    }

    return err('Not found', 404);
  },
};
