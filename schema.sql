-- IndoResto — PostgreSQL Schema
-- Run: psql $DATABASE_URL -f schema.sql

-- ─────────────────────────────────────────────────────────────
-- EXTENSIONS
-- ─────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm"; -- fuzzy search for menu items

-- ─────────────────────────────────────────────────────────────
-- RESTAURANTS
-- ─────────────────────────────────────────────────────────────
CREATE TABLE restaurants (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(120) NOT NULL,
  address     TEXT,
  phone       VARCHAR(20),
  email       VARCHAR(120),
  wa_phone_id VARCHAR(60),
  logo_url    TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────
-- TABLES (dining tables)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE tables (
  id            SERIAL PRIMARY KEY,
  restaurant_id INT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  table_number  SMALLINT NOT NULL,
  capacity      SMALLINT NOT NULL DEFAULT 4,
  qr_token      VARCHAR(32) UNIQUE DEFAULT substr(md5(random()::text), 1, 12),
  status        VARCHAR(16) NOT NULL DEFAULT 'free' CHECK (status IN ('free','occupied','reserved','cleaning')),
  UNIQUE (restaurant_id, table_number)
);

-- ─────────────────────────────────────────────────────────────
-- CUSTOMERS (CRM)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE customers (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(120) NOT NULL,
  phone         VARCHAR(20) UNIQUE,
  email         VARCHAR(120),
  birthday      DATE,
  notes         TEXT,
  allergies     TEXT[] DEFAULT '{}',           -- ['udang','kacang']
  total_visits  INT NOT NULL DEFAULT 0,
  total_spend   BIGINT NOT NULL DEFAULT 0,     -- in IDR (Rupiah)
  last_visit    TIMESTAMPTZ,
  loyalty_tier  VARCHAR(16) DEFAULT 'regular' CHECK (loyalty_tier IN ('regular','silver','gold','vip')),
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_customers_phone ON customers USING btree(phone);

-- ─────────────────────────────────────────────────────────────
-- MENU ITEMS
-- ─────────────────────────────────────────────────────────────
CREATE TABLE menu_categories (
  id         SERIAL PRIMARY KEY,
  name_id    VARCHAR(60) NOT NULL, -- Bahasa Indonesia
  name_en    VARCHAR(60) NOT NULL,
  emoji      VARCHAR(8),
  sort_order SMALLINT DEFAULT 0
);

CREATE TABLE menu_items (
  id           SERIAL PRIMARY KEY,
  restaurant_id INT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  category_id  INT REFERENCES menu_categories(id),
  name_id      VARCHAR(120) NOT NULL,           -- Bahasa Indonesia
  name_en      VARCHAR(120) NOT NULL,
  description_id TEXT,
  description_en TEXT,
  price        INT NOT NULL,                    -- IDR, no decimals
  photo_url    TEXT,
  emoji        VARCHAR(8),
  spice_level  SMALLINT DEFAULT 0 CHECK (spice_level BETWEEN 0 AND 3),
  has_spice_option BOOLEAN DEFAULT false,
  available    BOOLEAN DEFAULT true,
  is_popular   BOOLEAN DEFAULT false,
  prep_minutes SMALLINT DEFAULT 8,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_menu_items_category  ON menu_items(category_id);
CREATE INDEX idx_menu_items_available ON menu_items(available);
CREATE INDEX idx_menu_items_search    ON menu_items USING gin(name_id gin_trgm_ops, name_en gin_trgm_ops);

-- ─────────────────────────────────────────────────────────────
-- ORDERS
-- ─────────────────────────────────────────────────────────────
CREATE TYPE order_status AS ENUM ('open','preparing','ready','served','closed','cancelled');

CREATE TABLE orders (
  id            SERIAL PRIMARY KEY,
  restaurant_id INT NOT NULL REFERENCES restaurants(id),
  table_id      INT NOT NULL REFERENCES tables(id),
  customer_id   INT REFERENCES customers(id),
  status        order_status NOT NULL DEFAULT 'open',
  subtotal      INT NOT NULL DEFAULT 0,         -- IDR before tax
  tax           INT NOT NULL DEFAULT 0,
  service_charge INT NOT NULL DEFAULT 0,
  total         INT NOT NULL DEFAULT 0,
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  closed_at     TIMESTAMPTZ
);
CREATE INDEX idx_orders_table_status   ON orders(table_id, status);
CREATE INDEX idx_orders_restaurant     ON orders(restaurant_id, created_at DESC);
CREATE INDEX idx_orders_customer       ON orders(customer_id);

-- ─────────────────────────────────────────────────────────────
-- ORDER ITEMS
-- ─────────────────────────────────────────────────────────────
CREATE TYPE item_status AS ENUM ('pending','preparing','ready','served','cancelled');

CREATE TABLE order_items (
  id           SERIAL PRIMARY KEY,
  order_id     INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id INT NOT NULL REFERENCES menu_items(id),
  quantity     SMALLINT NOT NULL DEFAULT 1,
  unit_price   INT NOT NULL,                    -- snapshot price at order time
  spice_level  VARCHAR(20),                     -- 'tidak_pedas','sedang','extra_pedas'
  notes        TEXT,
  status       item_status NOT NULL DEFAULT 'pending',
  station      VARCHAR(20) DEFAULT 'main',      -- 'main','drinks','grill'
  prep_start   TIMESTAMPTZ,
  prep_end     TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_order_items_order  ON order_items(order_id);
CREATE INDEX idx_order_items_status ON order_items(status);

-- ─────────────────────────────────────────────────────────────
-- PAYMENTS
-- ─────────────────────────────────────────────────────────────
CREATE TYPE payment_status AS ENUM ('pending','paid','failed','refunded','fraud');
CREATE TYPE payment_method AS ENUM ('qris_gopay','qris_ovo','qris_dana','qris_shopee','qris_other','card_debit','card_credit','cash','bank_transfer');

CREATE TABLE payments (
  id              SERIAL PRIMARY KEY,
  order_id        INT NOT NULL REFERENCES orders(id),
  method          payment_method NOT NULL,
  amount          INT NOT NULL,
  status          payment_status NOT NULL DEFAULT 'pending',
  transaction_id  VARCHAR(120),               -- Midtrans transaction ID
  snap_token      VARCHAR(120),
  qr_url          TEXT,
  paid_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_payments_order  ON payments(order_id);
CREATE INDEX idx_payments_status ON payments(status);

-- ─────────────────────────────────────────────────────────────
-- QUEUE / WAITLIST
-- ─────────────────────────────────────────────────────────────
CREATE TYPE queue_status AS ENUM ('waiting','notified','seated','cancelled','no_show');

CREATE TABLE queue (
  id            SERIAL PRIMARY KEY,
  restaurant_id INT NOT NULL REFERENCES restaurants(id),
  customer_id   INT REFERENCES customers(id),
  party_size    SMALLINT NOT NULL,
  status        queue_status NOT NULL DEFAULT 'waiting',
  wa_notify     BOOLEAN DEFAULT false,
  estimated_wait SMALLINT,                    -- minutes
  joined_at     TIMESTAMPTZ DEFAULT NOW(),
  notified_at   TIMESTAMPTZ,
  seated_at     TIMESTAMPTZ
);
CREATE INDEX idx_queue_status ON queue(restaurant_id, status, joined_at);

-- ─────────────────────────────────────────────────────────────
-- CUSTOMER NOTES (server can add multiple)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE customer_notes (
  id          SERIAL PRIMARY KEY,
  customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  order_id    INT REFERENCES orders(id),
  note        TEXT NOT NULL,
  author      VARCHAR(60),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────
-- VOUCHERS / LOYALTY
-- ─────────────────────────────────────────────────────────────
CREATE TABLE vouchers (
  id            SERIAL PRIMARY KEY,
  customer_id   INT REFERENCES customers(id),
  code          VARCHAR(20) UNIQUE NOT NULL DEFAULT upper(substr(md5(random()::text), 1, 8)),
  discount_pct  SMALLINT DEFAULT 0,
  discount_idr  INT DEFAULT 0,
  min_spend     INT DEFAULT 0,
  reason        VARCHAR(60),                   -- 'birthday','loyalty','manual'
  used          BOOLEAN DEFAULT false,
  used_at       TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────
-- FUNCTIONS & TRIGGERS
-- ─────────────────────────────────────────────────────────────

-- Auto-update order totals when items change
CREATE OR REPLACE FUNCTION recalc_order_total() RETURNS TRIGGER AS $$
BEGIN
  UPDATE orders SET
    subtotal = (SELECT COALESCE(SUM(unit_price * quantity), 0) FROM order_items WHERE order_id = NEW.order_id AND status != 'cancelled'),
    tax      = ROUND((SELECT COALESCE(SUM(unit_price * quantity), 0) FROM order_items WHERE order_id = NEW.order_id AND status != 'cancelled') * 0.10),
    service_charge = ROUND((SELECT COALESCE(SUM(unit_price * quantity), 0) FROM order_items WHERE order_id = NEW.order_id AND status != 'cancelled') * 0.05),
    total    = ROUND((SELECT COALESCE(SUM(unit_price * quantity), 0) FROM order_items WHERE order_id = NEW.order_id AND status != 'cancelled') * 1.15)
  WHERE id = NEW.order_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_order_items_total
AFTER INSERT OR UPDATE OR DELETE ON order_items
FOR EACH ROW EXECUTE FUNCTION recalc_order_total();

-- Auto-update customer total_spend on payment
CREATE OR REPLACE FUNCTION update_customer_spend() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'paid' THEN
    UPDATE customers SET
      total_spend  = total_spend + NEW.amount,
      total_visits = total_visits + 1,
      last_visit   = NOW(),
      loyalty_tier = CASE
        WHEN total_spend + NEW.amount >= 10000000 THEN 'vip'
        WHEN total_spend + NEW.amount >= 5000000  THEN 'gold'
        WHEN total_spend + NEW.amount >= 1000000  THEN 'silver'
        ELSE 'regular'
      END
    WHERE id = (SELECT customer_id FROM orders WHERE id = NEW.order_id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_payment_customer
AFTER UPDATE ON payments
FOR EACH ROW WHEN (NEW.status = 'paid' AND OLD.status != 'paid')
EXECUTE FUNCTION update_customer_spend();

-- Auto-send birthday vouchers (run via pg_cron or cron job daily)
CREATE OR REPLACE FUNCTION send_birthday_vouchers() RETURNS void AS $$
BEGIN
  INSERT INTO vouchers (customer_id, discount_pct, min_spend, reason, expires_at)
  SELECT id, 20, 100000, 'birthday', NOW() + interval '30 days'
  FROM customers
  WHERE EXTRACT(MONTH FROM birthday) = EXTRACT(MONTH FROM NOW())
    AND EXTRACT(DAY   FROM birthday) = EXTRACT(DAY   FROM NOW())
    AND id NOT IN (
      SELECT customer_id FROM vouchers WHERE reason = 'birthday' AND created_at > NOW() - interval '1 year'
    );
END;
$$ LANGUAGE plpgsql;

-- ─────────────────────────────────────────────────────────────
-- REALTIME NOTIFY for WebSocket broadcast
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION notify_order_change() RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_notify(
    'order_events',
    json_build_object(
      'type',     TG_ARGV[0],
      'order_id', NEW.id,
      'table_id', NEW.table_id,
      'status',   NEW.status
    )::text
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_notify_order_new
AFTER INSERT ON orders
FOR EACH ROW EXECUTE FUNCTION notify_order_change('NEW_ORDER');

CREATE TRIGGER trg_notify_order_update
AFTER UPDATE OF status ON orders
FOR EACH ROW EXECUTE FUNCTION notify_order_change('ORDER_STATUS');

-- ─────────────────────────────────────────────────────────────
-- SEED: default restaurant + categories
-- ─────────────────────────────────────────────────────────────
INSERT INTO restaurants (name, address) VALUES ('IndoResto', 'Jakarta, Indonesia') ON CONFLICT DO NOTHING;

INSERT INTO menu_categories (name_id, name_en, emoji, sort_order) VALUES
  ('Nasi',    'Rice Dishes',  '🍚', 1),
  ('Mie',     'Noodles',      '🍜', 2),
  ('Ayam',    'Chicken',      '🍗', 3),
  ('Seafood', 'Seafood',      '🦐', 4),
  ('Sayur',   'Vegetables',   '🥬', 5),
  ('Minuman', 'Drinks',       '🥤', 6)
ON CONFLICT DO NOTHING;

-- Create 16 tables
INSERT INTO tables (restaurant_id, table_number, capacity)
SELECT 1, gs, CASE WHEN gs IN (6,11,16) THEN 6 WHEN gs = 16 THEN 8 ELSE 4 END
FROM generate_series(1, 16) gs
ON CONFLICT DO NOTHING;
