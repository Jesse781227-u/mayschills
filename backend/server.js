import crypto from 'node:crypto';
import express from 'express';
import pg from 'pg';
import webpush from 'web-push';

const { Pool } = pg;
const app = express();
const port = Number(process.env.PORT || 3000);
const configuredFrontendUrls = (process.env.FRONTEND_URL || '*')
    .split(',')
    .map(url => url.trim().replace(/\/$/, ''))
    .filter(Boolean);
const allowedFrontendUrls = new Set([...configuredFrontendUrls, 'capacitor://localhost', 'http://localhost', 'https://localhost', 'http://localhost:5500', 'http://127.0.0.1:5500']);
const pool = process.env.DATABASE_URL
    ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
    : null;
let uberToken = null;
let uberTokenExpiresAt = 0;
const defaultUberPickupAddress = JSON.stringify({
    street_address: ['Mayschills', '16 Adeola Raji Avenue', 'Atunrase Estate'],
    city: 'Lagos',
    state: 'Lagos',
    country: 'NG'
});

app.use(express.json({
    limit: '5mb',
    verify: (request, _response, buffer) => { request.rawBody = Buffer.from(buffer); }
}));
app.use((request, response, next) => {
    const requestOrigin = String(request.headers.origin || '').replace(/\/$/, '');
    if (allowedFrontendUrls.has('*') || allowedFrontendUrls.has(requestOrigin)) {
        response.header('Access-Control-Allow-Origin', allowedFrontendUrls.has('*') ? '*' : requestOrigin);
    }
    response.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
    response.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (request.method === 'OPTIONS') return response.sendStatus(204);
    next();
});

async function initializeDatabase() {
    if (!pool) return;
    await pool.query(`
        CREATE TABLE IF NOT EXISTS menu_availability (
            item_key TEXT PRIMARY KEY,
            mode TEXT NOT NULL CHECK (mode IN ('today', 'forever')),
            expires_at BIGINT,
            updated_at BIGINT NOT NULL
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS orders (
            id BIGSERIAL PRIMARY KEY,
            payment_reference TEXT UNIQUE NOT NULL,
            customer_name TEXT NOT NULL DEFAULT 'Customer',
            customer_email TEXT NOT NULL DEFAULT '',
            delivery_phone TEXT,
            order_type TEXT NOT NULL DEFAULT 'pickup',
            delivery_address TEXT,
            delivery_area TEXT,
            delivery_slot TEXT,
            order_notes TEXT,
            items JSONB NOT NULL DEFAULT '[]'::jsonb,
            subtotal NUMERIC(12,2) NOT NULL DEFAULT 0,
            delivery_fee NUMERIC(12,2) NOT NULL DEFAULT 0,
            total NUMERIC(12,2) NOT NULL DEFAULT 0,
            payment_status TEXT NOT NULL DEFAULT 'paid',
            notification_status TEXT NOT NULL DEFAULT 'pending',
            order_status TEXT NOT NULL DEFAULT 'received',
            requested_fulfillment_at TIMESTAMPTZ,
            dispatch_at TIMESTAMPTZ,
            ready_target_at TIMESTAMPTZ,
            manager_reminded_at TIMESTAMPTZ,
            customer_reminded_at TIMESTAMPTZ,
            is_gift BOOLEAN NOT NULL DEFAULT FALSE,
            gift_details JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            notified_at TIMESTAMPTZ
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS catalog_overrides (
            item_key TEXT PRIMARY KEY,
            item_data JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_status TEXT NOT NULL DEFAULT 'received'`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS requested_fulfillment_at TIMESTAMPTZ`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS dispatch_at TIMESTAMPTZ`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS ready_target_at TIMESTAMPTZ`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS manager_reminded_at TIMESTAMPTZ`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_reminded_at TIMESTAMPTZ`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS is_gift BOOLEAN NOT NULL DEFAULT FALSE`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS gift_details JSONB NOT NULL DEFAULT '{}'::jsonb`);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS shared_carts (
            id BIGSERIAL PRIMARY KEY,
            token TEXT UNIQUE NOT NULL,
            status TEXT NOT NULL DEFAULT 'awaiting_payment' CHECK (status IN ('awaiting_payment','paid','expired','cancelled')),
            items JSONB NOT NULL DEFAULT '[]'::jsonb,
            subtotal NUMERIC(12,2) NOT NULL DEFAULT 0,
            creator_name TEXT NOT NULL DEFAULT 'A customer',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            expires_at TIMESTAMPTZ NOT NULL
        )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS shared_carts_token_idx ON shared_carts (token)');
    await pool.query('CREATE INDEX IF NOT EXISTS orders_created_at_idx ON orders (created_at DESC)');
    await pool.query(`
        CREATE TABLE IF NOT EXISTS push_subscriptions (
            endpoint TEXT PRIMARY KEY,
            subscription JSONB NOT NULL,
            customer_email TEXT,
            customer_name TEXT,
            order_reference TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await pool.query(`ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS order_reference TEXT`);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS customer_notes (
            customer_key TEXT PRIMARY KEY,
            notes TEXT NOT NULL DEFAULT '',
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS customer_match_decisions (
            customer_key_a TEXT NOT NULL,
            customer_key_b TEXT NOT NULL,
            decision TEXT NOT NULL CHECK (decision IN ('same', 'different')),
            canonical_customer_key TEXT,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (customer_key_a, customer_key_b)
        )
    `);
    await pool.query('ALTER TABLE customer_match_decisions ADD COLUMN IF NOT EXISTS canonical_customer_key TEXT');
}

function json(response, status, body) {
    return response.status(status).json(body);
}

function adminSecret() {
    return process.env.ADMIN_SESSION_SECRET || process.env.ADMIN_PASSWORD || '';
}

function signAdminToken(payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = crypto.createHmac('sha256', adminSecret()).update(body).digest('base64url');
    return `${body}.${signature}`;
}

function verifyAdminToken(request) {
    const token = String(request.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token || !adminSecret()) return false;
    const [body, signature] = token.split('.');
    if (!body || !signature) return false;
    const expected = crypto.createHmac('sha256', adminSecret()).update(body).digest('base64url');
    if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;
    try {
        const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        return payload.role === 'admin' && payload.exp > Date.now();
    } catch {
        return false;
    }
}

function nextLagosMidnight() {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Africa/Lagos', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(now).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
    return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + 1, -1, 0, 0) - 1;
}

async function readAvailability() {
    if (!pool) return {};
    const result = await pool.query('SELECT item_key, mode, expires_at, updated_at FROM menu_availability');
    return Object.fromEntries(result.rows
        .filter(row => !(row.mode === 'today' && Number(row.expires_at) <= Date.now()))
        .map(row => [row.item_key, {
            mode: row.mode,
            expiresAt: row.expires_at ? Number(row.expires_at) : null,
            updatedAt: Number(row.updated_at)
        }]));
}

app.get('/health', (_request, response) => json(response, 200, { status: 'ok' }));

app.get('/', (_request, response) => json(response, 200, {
    name: "Mayschills backend",
    status: 'ok',
    health: '/health'
}));

app.get('/api/availability', async (_request, response) => {
    try {
        return json(response, 200, { items: await readAvailability() });
    } catch (error) {
        console.error('Availability read failed:', error);
        return json(response, 500, { error: 'Unable to read availability' });
    }
});

function uberConfigured() {
    return Boolean(process.env.UBER_CLIENT_ID && process.env.UBER_CLIENT_SECRET && process.env.UBER_CUSTOMER_ID);
}

function parseUberAddress(value, fieldName) {
    try {
        const address = typeof value === 'string' ? JSON.parse(value) : value;
        if (!address || typeof address !== 'object' || !Array.isArray(address.street_address) || !address.street_address.length) throw new Error('missing street_address');
        return address;
    } catch {
        throw new Error(`${fieldName} must be valid JSON with a street_address array`);
    }
}

async function getUberAccessToken() {
    if (uberToken && uberTokenExpiresAt > Date.now() + 60_000) return uberToken;
    const body = new URLSearchParams({
        client_id: process.env.UBER_CLIENT_ID,
        client_secret: process.env.UBER_CLIENT_SECRET,
        grant_type: 'client_credentials',
        scope: 'eats.deliveries'
    });
    const tokenResponse = await fetch('https://auth.uber.com/oauth/v2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body
    });
    const tokenData = await tokenResponse.json().catch(() => ({}));
    if (!tokenResponse.ok || !tokenData.access_token) {
        console.error('Uber OAuth failed:', tokenResponse.status, tokenData.error || tokenData.message || 'Unknown error');
        throw new Error('Uber authentication failed');
    }
    uberToken = tokenData.access_token;
    uberTokenExpiresAt = Date.now() + Number(tokenData.expires_in || 3600) * 1000;
    return uberToken;
}

app.post('/api/delivery/quote', async (request, response) => {
    if (!uberConfigured()) return json(response, 503, { error: 'Uber delivery pricing is not configured yet.' });
    const { address, area, name, phone } = request.body || {};
    if (!String(address || '').trim()) return json(response, 400, { error: 'A delivery address is required.' });
    try {
        const pickupAddress = parseUberAddress(process.env.UBER_PICKUP_ADDRESS || defaultUberPickupAddress, 'UBER_PICKUP_ADDRESS');
        const dropoffAddress = {
            street_address: [String(address).trim(), String(area || '').trim()].filter(Boolean),
            city: process.env.UBER_DROP_OFF_CITY || 'Lagos',
            state: process.env.UBER_DROP_OFF_STATE || 'Lagos',
            country: process.env.UBER_DROP_OFF_COUNTRY || 'NG'
        };
        const token = await getUberAccessToken();
        const quoteResponse = await fetch(`https://api.uber.com/v1/customers/${encodeURIComponent(process.env.UBER_CUSTOMER_ID)}/delivery_quotes`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                pickup_address: JSON.stringify(pickupAddress),
                dropoff_address: JSON.stringify(dropoffAddress)
            })
        });
        const quote = await quoteResponse.json().catch(() => ({}));
        if (!quoteResponse.ok || !quote.id || quote.fee === undefined) {
            console.error('Uber quote failed:', quoteResponse.status, quote.message || quote.errors || quote);
            return json(response, 502, { error: quote.message || 'Uber could not price this delivery.' });
        }
        return json(response, 200, {
            quoteId: quote.id,
            fee: Number(quote.fee) / 100,
            currency: quote.currency || 'NGN',
            expires: quote.expires || null,
            duration: quote.duration || null,
            dropoffEta: quote.dropoff_eta || null
        });
    } catch (error) {
        console.error('Uber quote error:', error.message);
        return json(response, 502, { error: error.message || 'Unable to get an Uber delivery quote.' });
    }
});

app.get('/api/orders/:reference/status', async (request, response) => {
    if (!pool) return json(response, 503, { error: 'DATABASE_URL is required' });
    try {
        const result = await pool.query(`
            SELECT payment_reference, customer_name, order_type, order_status, requested_fulfillment_at,
                   dispatch_at, ready_target_at, created_at
            FROM orders WHERE payment_reference = $1 LIMIT 1
        `, [request.params.reference]);
        if (!result.rowCount) return json(response, 404, { error: 'Order not found' });
        const order = result.rows[0];
        return json(response, 200, { order: { reference: order.payment_reference, customerName: order.customer_name, type: order.order_type, status: order.order_status, requestedFulfillmentAt: order.requested_fulfillment_at, dispatchAt: order.dispatch_at, readyTargetAt: order.ready_target_at, createdAt: order.created_at } });
    } catch (error) { console.error('Order tracking read failed:', error); return json(response, 500, { error: 'Unable to read order status' }); }
});

app.get('/api/shared-carts/:token', async (request, response) => {
    if (!pool) return json(response, 503, { error: 'DATABASE_URL is required' });
    try {
        const result = await pool.query('SELECT token, status, items, subtotal, creator_name, created_at, expires_at FROM shared_carts WHERE token = $1 LIMIT 1', [String(request.params.token || '').trim()]);
        if (!result.rowCount) return json(response, 404, { error: 'Shared cart not found' });
        const cart = result.rows[0];
        if (cart.status === 'awaiting_payment' && new Date(cart.expires_at).getTime() <= Date.now()) {
            await pool.query("UPDATE shared_carts SET status = 'expired' WHERE token = $1 AND status = 'awaiting_payment'", [cart.token]);
            cart.status = 'expired';
        }
        return json(response, 200, { sharedCart: { token: cart.token, status: cart.status, items: cart.items, subtotal: Number(cart.subtotal), creatorName: cart.creator_name, createdAt: cart.created_at, expiresAt: cart.expires_at } });
    } catch (error) { console.error('Shared cart read failed:', error); return json(response, 500, { error: 'Unable to read shared cart' }); }
});

app.post('/api/shared-carts', async (request, response) => {
    if (!pool) return json(response, 503, { error: 'DATABASE_URL is required' });
    const items = Array.isArray(request.body?.items) ? request.body.items : [];
    const subtotal = Number(request.body?.subtotal || 0);
    const creatorName = String(request.body?.creatorName || 'A customer').trim().slice(0, 120) || 'A customer';
    if (!items.length || !Number.isFinite(subtotal) || subtotal <= 0) return json(response, 400, { error: 'A non-empty cart is required' });
    const token = crypto.randomBytes(9).toString('base64url');
    try {
        const result = await pool.query(`
            INSERT INTO shared_carts (token, items, subtotal, creator_name, expires_at)
            VALUES ($1, $2::jsonb, $3, $4, NOW() + INTERVAL '24 hours')
            RETURNING token, status, items, subtotal, creator_name, created_at, expires_at
        `, [token, JSON.stringify(items), subtotal, creatorName]);
        const cart = result.rows[0];
        return json(response, 201, { sharedCart: { token: cart.token, status: cart.status, items: cart.items, subtotal: Number(cart.subtotal), creatorName: cart.creator_name, createdAt: cart.created_at, expiresAt: cart.expires_at } });
    } catch (error) { console.error('Shared cart create failed:', error); return json(response, 500, { error: 'Unable to create shared cart' }); }
});

app.post('/api/shared-carts/:token/cancel', async (request, response) => {
    if (!pool) return json(response, 503, { error: 'DATABASE_URL is required' });
    try {
        const result = await pool.query("UPDATE shared_carts SET status = 'cancelled' WHERE token = $1 AND status = 'awaiting_payment' RETURNING token, status", [String(request.params.token || '').trim()]);
        if (!result.rowCount) return json(response, 404, { error: 'Shared cart is unavailable or already paid' });
        return json(response, 200, { sharedCart: result.rows[0] });
    } catch (error) { console.error('Shared cart cancellation failed:', error); return json(response, 500, { error: 'Unable to cancel shared cart' }); }
});

app.post('/api/admin/login', (request, response) => {
    const { password } = request.body || {};
    if (!process.env.ADMIN_PASSWORD) {
        return json(response, 503, { error: 'Admin login is not configured on the backend' });
    }
    if (password !== process.env.ADMIN_PASSWORD) {
        return json(response, 401, { error: 'Invalid password' });
    }
    const token = signAdminToken({ role: 'admin', exp: Date.now() + 8 * 60 * 60 * 1000 });
    return json(response, 200, { token });
});

app.get('/api/notifications/config', (_request, response) => json(response, 200, {
    enabled: Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT),
    publicKey: process.env.VAPID_PUBLIC_KEY || null
}));

app.post('/api/notifications/subscribe', async (request, response) => {
    if (!pool) return json(response, 503, { error: 'DATABASE_URL is required' });
    const subscription = request.body?.subscription;
    const endpoint = String(subscription?.endpoint || '').trim();
    if (!endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) return json(response, 400, { error: 'Invalid push subscription' });
    try {
        await pool.query(`
            INSERT INTO push_subscriptions (endpoint, subscription, customer_email, customer_name, order_reference)
            VALUES ($1, $2::jsonb, $3, $4, $5)
            ON CONFLICT (endpoint) DO UPDATE SET subscription=$2::jsonb, customer_email=$3, customer_name=$4, order_reference=$5, updated_at=NOW()
        `, [endpoint, JSON.stringify(subscription), request.body?.email || null, request.body?.name || null, request.body?.reference || null]);
        return json(response, 201, { success: true });
    } catch (error) {
        console.error('Push subscription failed:', error);
        return json(response, 500, { error: 'Unable to save notification permission' });
    }
});

app.post('/api/notifications/demo', async (request, response) => {
    if (!pool) return json(response, 503, { error: 'DATABASE_URL is required' });
    const email = String(request.body?.email || '').trim().toLowerCase();
    const name = String(request.body?.name || 'Notification demo customer').trim().slice(0, 120) || 'Notification demo customer';
    if (!/^\S+@\S+\.\S+$/.test(email)) return json(response, 400, { error: 'A valid email is required for the demo.' });
    try {
        const reference = `DEMO_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
        await pool.query('UPDATE push_subscriptions SET order_reference=$1 WHERE endpoint=$2', [reference, String(request.body?.endpoint || '')]);
        const result = await pool.query(`
            INSERT INTO orders (payment_reference, customer_name, customer_email, delivery_phone, order_type, order_notes, items, subtotal, total, payment_status, order_status, ready_target_at, is_demo)
            VALUES ($1,$2,$3,'Demo order','pickup','Notification demo','[{"id":"notification-demo","name":"Notification demo","price":100,"quantity":1}]'::jsonb,100,100,'paid','received',NOW() + INTERVAL '2 hours',TRUE)
            RETURNING payment_reference, customer_name, customer_email, order_status
        `, [reference, name, email]);
        return json(response, 201, { success: true, order: result.rows[0] });
    } catch (error) { console.error('Push demo order failed:', error); return json(response, 500, { error: 'Unable to create the demo order' }); }
});

app.get('/api/catalog', async (_request, response) => {
    if (!pool) return json(response, 200, { items: {} });
    try {
        const result = await pool.query('SELECT item_key, item_data FROM catalog_overrides');
        return json(response, 200, { items: Object.fromEntries(result.rows.map(row => [row.item_key, row.item_data])) });
    } catch (error) {
        console.error('Catalog read failed:', error);
        return json(response, 500, { error: 'Unable to read catalog' });
    }
});

app.post('/api/catalog', async (request, response) => {
    if (!verifyAdminToken(request)) return json(response, 401, { error: 'Unauthorized' });
    if (!pool) return json(response, 503, { error: 'DATABASE_URL is required' });
    const key = String(request.body?.key || '').trim();
    const data = request.body?.data;
    if (!key || !data || typeof data !== 'object' || Array.isArray(data)) return json(response, 400, { error: 'Invalid catalog item' });
    try {
        await pool.query(`
            INSERT INTO catalog_overrides (item_key, item_data, updated_at) VALUES ($1, $2::jsonb, NOW())
            ON CONFLICT (item_key) DO UPDATE SET item_data = $2::jsonb, updated_at = NOW()
        `, [key, JSON.stringify(data)]);
        return json(response, 200, { success: true });
    } catch (error) {
        console.error('Catalog update failed:', error);
        return json(response, 500, { error: 'Unable to update catalog' });
    }
});

app.get('/api/admin/login', (_request, response) => json(response, 405, {
    error: 'Login requires POST',
    message: 'Open admin.html to sign in.'
}));

app.post('/api/availability', async (request, response) => {
    if (!verifyAdminToken(request)) return json(response, 401, { error: 'Unauthorized' });
    if (!pool) return json(response, 503, { error: 'DATABASE_URL is required' });
    const key = String(request.body?.key || '').trim();
    const mode = request.body?.mode;
    if (!key || !['today', 'forever', 'enabled'].includes(mode)) {
        return json(response, 400, { error: 'Invalid availability update' });
    }
    if (mode === 'enabled') {
        await pool.query('DELETE FROM menu_availability WHERE item_key = $1', [key]);
    } else {
        const expiresAt = mode === 'today' ? nextLagosMidnight() : null;
        await pool.query(`
            INSERT INTO menu_availability (item_key, mode, expires_at, updated_at)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (item_key) DO UPDATE SET mode = $2, expires_at = $3, updated_at = $4
        `, [key, mode, expiresAt, Date.now()]);
    }
    return json(response, 200, { success: true });
});

app.get('/api/admin/orders', async (request, response) => {
    if (!verifyAdminToken(request)) return json(response, 401, { error: 'Unauthorized' });
    if (!pool) return json(response, 503, { error: 'DATABASE_URL is required' });
    try {
        const result = await pool.query(`
            SELECT id, payment_reference, customer_name, customer_email, delivery_phone, is_demo, is_gift, gift_details,
                   order_type, delivery_address, delivery_area, delivery_slot, order_notes,
                   items, subtotal, delivery_fee, total, payment_status, order_status, notification_status,
                   requested_fulfillment_at, dispatch_at, ready_target_at, manager_reminded_at, customer_reminded_at,
                   created_at, notified_at,
                   (order_status IN ('received','preparing') AND ready_target_at IS NOT NULL AND NOW() >= ready_target_at) AS attention_required
            FROM orders ORDER BY created_at DESC LIMIT 100
        `);
        return json(response, 200, { orders: result.rows });
    } catch (error) {
        console.error('Orders read failed:', error);
        return json(response, 500, { error: 'Unable to read orders' });
    }
});

function normalizeCustomerName(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .replace(/[^a-z0-9]/gi, '');
}

function normalizeEmail(value) {
    return String(value || '').trim().toLowerCase();
}

function normalizePhone(value) {
    return String(value || '').replace(/\D/g, '');
}

function uniqueValues(values) {
    const cleaned = (Array.isArray(values) ? values : [values])
        .map(value => String(value || '').trim())
        .filter(Boolean)
        .filter((value, index, list) => list.indexOf(value) === index);
    return cleaned;
}

function customerKey(order) {
    const email = normalizeEmail(order.customer_email);
    const phone = normalizePhone(order.delivery_phone);
    const name = normalizeCustomerName(order.customer_name || 'customer');
    if (email && email !== 'unknown@example.com') return `email:${email}`;
    if (phone && phone !== '0') return `phone:${phone}`;
    return `order:${String(order.payment_reference || name)}`;
}

function identityMatch(orderA, orderB) {
    const emailA = normalizeEmail(orderA.customer_email || orderA.customerEmail);
    const emailB = normalizeEmail(orderB.customer_email || orderB.customerEmail);
    const phoneA = normalizePhone(orderA.delivery_phone || orderA.deliveryPhone);
    const phoneB = normalizePhone(orderB.delivery_phone || orderB.deliveryPhone);
    if (emailA && emailB && emailA === emailB) return true;
    if (phoneA && phoneB && phoneA === phoneB) return true;
    return false;
}

function customerNameTokens(value) {
    return new Set(String(value || '').trim().toLowerCase().split(/\s+/).map(token => token.replace(/[^a-z0-9]/g, '')).filter(Boolean));
}

function namesNeedConfirmation(left, right) {
    const leftTokens = customerNameTokens(left);
    const rightTokens = customerNameTokens(right);
    return [...leftTokens].some(token => rightTokens.has(token));
}

function customerPairKey(left, right) {
    return [String(left || ''), String(right || '')].sort().join('|');
}

function orderItems(order) {
    return Array.isArray(order.items) ? order.items : [];
}

function analyticsDate(value, fallback) {
    const date = value ? new Date(value) : fallback;
    return Number.isNaN(date.getTime()) ? fallback : date;
}

function percentChange(current, previous) {
    if (!previous) return current ? null : 0;
    return Math.round(((current - previous) / previous) * 100);
}

function buildAnalytics(orders, notes = {}, decisions = {}, range = {}) {
    const now = new Date();
    const end = analyticsDate(range.to, now);
    const start = analyticsDate(range.from, new Date(end));
    if (!range.from) start.setDate(start.getDate() - 30);
    const periodOrders = orders.filter(order => new Date(order.created_at) >= start && new Date(order.created_at) <= end);
    const periodLength = Math.max(86400000, end.getTime() - start.getTime() + 86400000);
    const previousStart = new Date(start.getTime() - periodLength);
    const previousOrders = orders.filter(order => new Date(order.created_at) >= previousStart && new Date(order.created_at) < start);
    const summarize = selected => {
        const products = new Map(); let sales = 0; let units = 0; const customers = new Set();
        selected.forEach(order => {
            sales += Number(order.total || 0); customers.add(customerKey(order));
            orderItems(order).forEach(item => {
                const key = String(item.id || item.name || 'item');
                const row = products.get(key) || { key, id: item.id || key, name: item.name || key, units: 0, revenue: 0, orders: 0 };
                const quantity = Number(item.quantity || 0); row.units += quantity; row.revenue += Number(item.price || 0) * quantity; row.orders += 1; products.set(key, row); units += quantity;
            });
        });
        return { sales, orders: selected.length, units, customers: customers.size, products: [...products.values()] };
    };
    const current = summarize(periodOrders); const previous = summarize(previousOrders);
    const parent = orders.map((_order, index) => index);
    const findRoot = index => { let root = index; while (parent[root] !== root) root = parent[root]; while (parent[index] !== index) { const next = parent[index]; parent[index] = root; index = next; } return root; };
    const union = (left, right) => { const leftRoot = findRoot(left); const rightRoot = findRoot(right); if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot; };
    orders.forEach((order, index) => orders.slice(index + 1).forEach((other, otherIndex) => { if (identityMatch(order, other)) union(index, index + otherIndex + 1); }));
    const orderKeys = orders.map(order => customerKey(order));
    const canonicalByKey = new Map();
    Object.entries(decisions).forEach(([pair, decision]) => {
        if (decision?.decision !== 'same') return;
        const [left, right] = pair.split('|');
        const leftIndex = orderKeys.findIndex(key => key === left);
        const rightIndex = orderKeys.findIndex(key => key === right);
        if (leftIndex >= 0 && rightIndex >= 0) union(leftIndex, rightIndex);
        if (decision.canonicalKey) { canonicalByKey.set(left, decision.canonicalKey); canonicalByKey.set(right, decision.canonicalKey); }
    });
    const customerMap = new Map(); const productMap = new Map(); const daily = new Map(); const hours = new Map();
    orders.forEach(order => {
        const date = new Date(order.created_at); const inPeriod = date >= start && date <= end;
        const normalizedName = String(order.customer_name || 'Customer').trim();
        const orderIndex = orders.indexOf(order);
        const root = findRoot(orderIndex);
        const rootKey = customerKey(orders[root]);
        let key = canonicalByKey.get(rootKey) || rootKey;
        let customer = customerMap.get(key);
        if (!customer) {
            customer = {
                key,
                name: normalizedName || 'Customer',
                phone: order.delivery_phone || '',
                email: order.customer_email || '',
                addresses: [],
                emails: [],
                phones: [],
                orders: [],
                spent: 0,
                items: new Map(),
                needsConfirmation: false
            };
            customerMap.set(key, customer);
        }
        customer.orders.push(order); customer.spent += Number(order.total || 0);
        customer.addresses = uniqueValues([...customer.addresses, order.delivery_address || '']);
        customer.emails = uniqueValues([...customer.emails, order.customer_email || '']);
        customer.phones = uniqueValues([...customer.phones, order.delivery_phone || '']);
        if (order.delivery_phone && customer.phone !== order.delivery_phone) customer.phone = order.delivery_phone;
        if (order.customer_email && customer.email !== order.customer_email) customer.email = order.customer_email;
        if ((normalizedName || 'Customer') && customer.name !== normalizedName) customer.name = normalizedName || 'Customer';
        orderItems(order).forEach(item => {
            const itemKey = String(item.id || item.name || 'item'); const quantity = Number(item.quantity || 0);
            customer.items.set(itemKey, (customer.items.get(itemKey) || { name: item.name || itemKey, quantity: 0 })).quantity += quantity;
            if (!inPeriod) return;
            const row = productMap.get(itemKey) || { key: itemKey, id: item.id || itemKey, name: item.name || itemKey, units: 0, revenue: 0, orders: 0, dates: [], customers: new Map(), days: new Map(), hours: new Map(), alongside: new Map() };
            row.units += quantity; row.revenue += Number(item.price || 0) * quantity; row.orders += 1; row.dates.push(date);
            row.customers.set(key, (row.customers.get(key) || 0) + quantity);
            const day = date.toLocaleDateString('en-NG', { weekday: 'long', timeZone: 'Africa/Lagos' }); row.days.set(day, (row.days.get(day) || 0) + quantity);
            const hour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: 'Africa/Lagos' }).format(date)); row.hours.set(hour, (row.hours.get(hour) || 0) + quantity);
            orderItems(order).forEach(other => { const otherKey = String(other.id || other.name || 'item'); if (otherKey !== itemKey) row.alongside.set(otherKey, { name: other.name || otherKey, count: (row.alongside.get(otherKey)?.count || 0) + 1 }); });
            productMap.set(itemKey, row);
        });
        const dayKey = date.toISOString().slice(0, 10); daily.set(dayKey, (daily.get(dayKey) || 0) + Number(order.total || 0));
        const hourKey = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: 'Africa/Lagos' }).format(date)); hours.set(hourKey, (hours.get(hourKey) || 0) + 1);
    });
    const groupedCustomers = [...customerMap.values()];
    groupedCustomers.forEach((customer, index) => groupedCustomers.slice(index + 1).forEach(other => {
        if (namesNeedConfirmation(customer.name, other.name) && decisions[customerPairKey(customer.key, other.key)]?.decision !== 'different') {
            customer.needsConfirmation = true;
            other.needsConfirmation = true;
        }
    }));
    const customers = groupedCustomers.map(customer => {
        const sorted = [...customer.items.values()].sort((a, b) => b.quantity - a.quantity); const last = customer.orders.at(-1)?.created_at; const first = customer.orders[0]?.created_at; const daysSince = last ? (Date.now() - new Date(last).getTime()) / 86400000 : Infinity;
        const addresses = uniqueValues(customer.addresses || []);
        const emails = uniqueValues(customer.emails || []);
        const phones = uniqueValues(customer.phones || []);
        let segment = customer.orders.length === 1 ? 'New customer' : 'Returning customer';
        if (customer.spent >= 100000) segment = 'High-value customer'; else if (customer.orders.length >= 5) segment = 'Frequent customer'; else if (daysSince > 60) segment = 'Inactive customer'; else if (daysSince > 30 && customer.orders.length > 1) segment = 'At-risk customer'; else if (customer.orders.length >= 3) segment = 'Regular customer';
        const needsConfirmation = Boolean(customer.needsConfirmation);
        return { key: customer.key, name: customer.name, phone: customer.phone, email: customer.email, address: addresses[0] || customer.orders.at(-1)?.delivery_address || '—', addresses, emails, phones, orders: customer.orders.length, spent: customer.spent, averageOrderValue: customer.spent / customer.orders.length, firstOrder: first, lastOrder: last, segment: needsConfirmation ? 'Needs confirmation' : segment, needsConfirmation, favoriteProduct: sorted[0]?.name || '—', favoriteItems: sorted.slice(0, 5).map(item => ({ ...item, quantity: Number(item.quantity || 0), orders: Number(item.orders || item.quantity || 0) })), orderIds: customer.orders.map(order => order.payment_reference), items: sorted, history: customer.orders.map(order => ({ reference: order.payment_reference, date: order.created_at, total: Number(order.total || 0), status: order.order_status, address: order.delivery_address || '—', items: orderItems(order).map(item => ({ name: item.name, quantity: Number(item.quantity || 0), price: item.price == null ? null : Number(item.price) })) })), notes: notes[customer.key] || '' };
    });
    const products = [...productMap.values()].map(row => ({ key: row.key, id: row.id, name: row.name, units: row.units, revenue: row.revenue, orders: row.orders, averageQuantity: row.units / row.orders, firstSale: row.dates.sort((a, b) => a - b)[0], lastSale: row.dates.sort((a, b) => b - a)[0], customers: [...row.customers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([key]) => customers.find(customer => customer.key === key)?.name || 'Customer'), alongside: [...row.alongside.values()].sort((a, b) => b.count - a.count).slice(0, 5), bestDays: [...row.days.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([name]) => name), bestHours: [...row.hours.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([hour]) => `${hour}:00`), trend: percentChange(row.revenue, previous.products.find(item => item.key === row.key)?.revenue || 0) }));
    const newCustomers = customers.filter(customer => customer.firstOrder && new Date(customer.firstOrder) >= start).length;
    const returningCustomers = customers.filter(customer => customer.orders > 1).length;
    const top = [...products].sort((a, b) => b.units - a.units)[0]; const topRevenue = [...products].sort((a, b) => b.revenue - a.revenue)[0];
    const insights = [];
    const periodLabel = periodLength <= 86400000 ? 'today' : `${Math.round(periodLength / 86400000)} days`;
    if (top) insights.push(`${top.name} is your best-selling product for ${periodLabel}.`);
    if (topRevenue && topRevenue.key !== top?.key) insights.push(`${topRevenue.name} generated the most revenue for ${periodLabel}.`);
    if (current.sales && previous.sales) insights.push(`Sales are ${Math.abs(percentChange(current.sales, previous.sales))}% ${current.sales >= previous.sales ? 'higher' : 'lower'} than the previous matching period.`);
    if (returningCustomers && current.customers) insights.push(`Returning customers represent ${Math.round((returningCustomers / current.customers) * 100)}% of identified customers.`);
    const busiestHour = [...hours.entries()].sort((a, b) => b[1] - a[1])[0]; if (busiestHour) insights.push(`Most orders occur around ${busiestHour[0]}:00–${Number(busiestHour[0]) + 1}:00.`);
    return { period: { from: start, to: end }, summary: { ...current, averageOrderValue: current.orders ? current.sales / current.orders : 0, newCustomers, returningCustomers, salesChange: percentChange(current.sales, previous.sales), orderChange: percentChange(current.orders, previous.orders), uniqueCustomers: current.customers }, daily: [...daily.entries()].filter(([day]) => new Date(day) >= start).map(([date, sales]) => ({ date, sales })), products: products.filter(product => product.orders), customers: customers.sort((a, b) => b.spent - a.spent), insights, previous };
}

app.get('/api/admin/analytics', async (request, response) => {
    if (!verifyAdminToken(request)) return json(response, 401, { error: 'Unauthorized' });
    if (!pool) return json(response, 503, { error: 'DATABASE_URL is required' });
    try {
        const [ordersResult, notesResult, decisionsResult] = await Promise.all([
            pool.query("SELECT payment_reference, customer_name, customer_email, delivery_phone, delivery_address, items, total, order_status, payment_status, created_at FROM orders WHERE payment_status = 'paid' AND is_demo = FALSE ORDER BY created_at ASC LIMIT 10000"),
            pool.query('SELECT customer_key, notes FROM customer_notes'),
            pool.query('SELECT customer_key_a, customer_key_b, decision, canonical_customer_key FROM customer_match_decisions')
        ]);
        const notes = Object.fromEntries(notesResult.rows.map(row => [row.customer_key, row.notes]));
        const decisions = Object.fromEntries(decisionsResult.rows.map(row => [customerPairKey(row.customer_key_a, row.customer_key_b), { decision: row.decision, canonicalKey: row.canonical_customer_key }]));
        const to = request.query.to ? new Date(`${request.query.to}T23:59:59`) : null;
        const from = request.query.from ? new Date(`${request.query.from}T00:00:00`) : null;
        return json(response, 200, buildAnalytics(ordersResult.rows.filter(order => order.order_status !== 'cancelled'), notes, decisions, { from, to }));
    } catch (error) { console.error('Analytics read failed:', error); return json(response, 500, { error: 'Unable to calculate analytics' }); }
});

app.patch('/api/admin/customers/:key/notes', async (request, response) => {
    if (!verifyAdminToken(request)) return json(response, 401, { error: 'Unauthorized' });
    if (!pool) return json(response, 503, { error: 'DATABASE_URL is required' });
    try { await pool.query('INSERT INTO customer_notes (customer_key, notes, updated_at) VALUES ($1,$2,NOW()) ON CONFLICT (customer_key) DO UPDATE SET notes=$2, updated_at=NOW()', [key, notes]); return json(response, 200, { success: true }); }
    catch (error) { console.error('Customer notes update failed:', error); return json(response, 500, { error: 'Unable to save customer notes' }); }
});

app.patch('/api/admin/customers/match', async (request, response) => {
    if (!verifyAdminToken(request)) return json(response, 401, { error: 'Unauthorized' });
    if (!pool) return json(response, 503, { error: 'DATABASE_URL is required' });
    const left = String(request.body?.leftKey || '');
    const right = String(request.body?.rightKey || '');
    const decision = String(request.body?.decision || '');
    const canonicalKey = String(request.body?.canonicalKey || '');
    if (!left || !right || left === right || !['same', 'different'].includes(decision)) return json(response, 400, { error: 'Invalid customer match decision' });
    const [a, b] = [left, right].sort();
    try {
        await pool.query('INSERT INTO customer_match_decisions (customer_key_a, customer_key_b, decision, canonical_customer_key, updated_at) VALUES ($1,$2,$3,$4,NOW()) ON CONFLICT (customer_key_a, customer_key_b) DO UPDATE SET decision=$3, canonical_customer_key=$4, updated_at=NOW()', [a, b, decision, decision === 'same' && [a, b].includes(canonicalKey) ? canonicalKey : null]);
        return json(response, 200, { success: true });
    } catch (error) { console.error('Customer match decision failed:', error); return json(response, 500, { error: 'Unable to save customer match decision' }); }
});

app.patch('/api/admin/orders/:reference/status', async (request, response) => {
    if (!verifyAdminToken(request)) return json(response, 401, { error: 'Unauthorized' });
    if (!pool) return json(response, 503, { error: 'DATABASE_URL is required' });
    const allowed = ['received', 'preparing', 'ready', 'in_transit', 'delivered', 'picked_up', 'cancelled'];
    const status = String(request.body?.status || '');
    if (!allowed.includes(status)) return json(response, 400, { error: 'Invalid order status' });
    try {
        const result = await pool.query('UPDATE orders SET order_status=$1 WHERE payment_reference=$2 RETURNING *', [status, request.params.reference]);
        if (!result.rowCount) return json(response, 404, { error: 'Order not found' });
        const order = result.rows[0];
        const pushSent = await sendOrderPush(order, orderStatusMessage(status, order.customer_name));
        return json(response, 200, { success: true, pushSent });
    } catch (error) {
        console.error('Order status update failed:', error);
        return json(response, 500, { error: 'Unable to update order status' });
    }
});

function orderStatusMessage(status, customerName = 'there') {
    const firstName = String(customerName || 'there').trim().split(/\s+/)[0] || 'there';
    const messages = {
        received: `Thank you, ${firstName}. We have received your order and it is now in our queue.`,
        preparing: `Good news, ${firstName} — we are carefully preparing your order now.`,
        ready: `Your order is ready, ${firstName}. We look forward to serving you at Mayschills.`,
        in_transit: `Your order is in transit, ${firstName}. It will be with you shortly.`,
        out_for_delivery: `Your order is in transit, ${firstName}. It will be with you shortly.`,
        delivered: `Your order has been delivered, ${firstName}. We hope you enjoy every sip and bite!`,
        picked_up: `Your order has been picked up, ${firstName}. Thank you for choosing Mayschills.`,
        cancelled: `Your order has been cancelled, ${firstName}. Please contact us if you need any assistance.`
    };
    return messages[status] || `There is a new update regarding your Mayschills order, ${firstName}.`;
}

function verifyPaystackSignature(request, rawBody) {
    const signature = request.headers['x-paystack-signature'];
    const secret = process.env.PAYSTACK_SECRET;
    if (!signature || !secret) return false;
    const expected = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
    return signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

function formatCustomizationLines(item) {
    const customizations = item.customizations || {};
    const label = value => String(value ?? '')
        .replace(/^ex_/, '')
        .replace(/_/g, ' ')
        .replace(/\b\w/g, character => character.toUpperCase());
    const lines = [];
    if (!item.customizations && Array.isArray(item.customizationSummary)) return item.customizationSummary.map(String);
    const isSalad = customizations.type === 'salad';
    if (customizations.type && !isSalad) lines.push(`Customization type: ${label(customizations.type)}`);
    const choices = customizations.choices || {};
    const choiceLabels = { saladOption: 'Salad option', protein: 'Protein selection', chickenStyle: 'Chicken style', toppings: 'Toppings', placement: 'Topping placement', honey: 'Honey preference' };
    Object.entries(choices).forEach(([key, value]) => {
        if (value === '' || value === null || value === undefined || value === 'DEFAULT' || value === 'MIXED') return;
        if (isSalad && key === 'chickenStyle') return;
        const rendered = Array.isArray(value) ? value.map(label).join(', ') : String(value).split('+').map(label).join(' + ');
        lines.push(`${choiceLabels[key] || label(key)}: ${rendered}`);
    });
    (customizations.removed || []).forEach(id => lines.push(`Removed: ${label(id)}`));
    Object.entries(customizations.substitutions || {}).forEach(([from, to]) => lines.push(`Substitute: ${label(from)} -> ${label(to)}`));
    (customizations.additions || []).forEach(addition => {
        const quantity = Number(addition.quantity || 1);
        const unitPrice = Number(addition.price || 0);
        const price = unitPrice * quantity;
        const style = addition.style ? ` (${addition.style})` : '';
        const priceText = unitPrice ? ` +NGN${unitPrice.toLocaleString()} each${quantity > 1 ? ` (NGN${price.toLocaleString()} total)` : ''}` : '';
        lines.push(`Added extra: ${quantity > 1 ? `${quantity}x ` : ''}${addition.name || label(addition.id)}${style}${priceText}`);
    });
    const customizationTotal = Number(item.customizationTotal || 0);
    lines.push(`Total customization cost: +NGN${customizationTotal.toLocaleString()}`);
    return lines;
}

function escapeTelegram(value) {
    return String(value ?? '').replace(/[&<>]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character]);
}

function normalizeOrderItems(items) {
    let parsed = items;
    if (typeof parsed === 'string') {
        try { parsed = JSON.parse(parsed); } catch (_error) { parsed = []; }
    }
    if (!Array.isArray(parsed)) return [];
    return parsed.map(item => {
        if (!item || typeof item !== 'object') return item;
        let customizations = item.customizations || null;
        if (typeof customizations === 'string') {
            try { customizations = JSON.parse(customizations); } catch (_error) { customizations = null; }
        }
        return { ...item, customizations };
    });
}

function buildItemsText(items, escapeValues = false) {
    return items.map(item => {
        const total = Number(item.price || 0) * Number(item.quantity || 0);
        const render = value => escapeValues ? escapeTelegram(value) : value;
        const details = formatCustomizationLines(item).map(line => `\n  - ${render(line)}`).join('');
        return `${item.quantity}x ${render(item.name)} - NGN${total.toLocaleString()}${details}`;
    }).join('\n');
}

async function sendEmail(order) {
    if (!process.env.EMAILJS_SERVICE || !process.env.EMAILJS_TEMPLATE || !process.env.EMAILJS_KEY || !process.env.BUSINESS_EMAIL) return false;
    const response = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            service_id: process.env.EMAILJS_SERVICE,
            template_id: process.env.EMAILJS_TEMPLATE,
            user_id: process.env.EMAILJS_KEY,
            template_params: {
                to_email: process.env.BUSINESS_EMAIL,
                to_name: "Mayschills",
                order_id: `MCH-${String(order.id).slice(-8)}`,
                customer_name: order.customerName || 'Guest Customer',
                customer_email: order.customerEmail || 'No email provided',
                customer_phone: order.deliveryPhone || 'Not provided',
                order_type: order.type || 'Order',
                order_items: order.items.map(item => ({ ...item, customization_details: formatCustomizationLines(item).join('; ') })),
                order_items_text: buildItemsText(order.items),
                order_count: `${order.items.length} item(s)`,
                subtotal: `NGN${Number(order.subtotal || 0).toLocaleString()}`,
                delivery_fee: `NGN${Number(order.deliveryFee || 0).toLocaleString()}`,
                total_amount: `NGN${Number(order.total || 0).toLocaleString()}`,
                delivery_address: order.deliveryAddress || 'Pickup order',
                delivery_area: order.deliveryArea || 'N/A',
                delivery_slot: order.deliverySlot || order.pickupTime || 'Not specified',
                payment_reference: order.paymentReference || 'N/A',
                payment_status: 'PAID',
                payment_method: 'Paystack',
                order_date: order.date,
                is_gift: order.isGift ? 'YES' : 'NO',
                gift_recipient_name: order.giftDetails?.recipientName || '',
                gift_recipient_phone: order.giftDetails?.recipientPhone || '',
                gift_message: order.giftDetails?.message || ''
            }
        })
    });
    return response.ok;
}

async function sendTelegram(order) {
    if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) return false;
    const extraDetails = order.type === 'delivery'
        ? [
            `<b>Area:</b> ${escapeTelegram(order.deliveryArea || 'N/A')}`,
            `<b>Address:</b> ${escapeTelegram(order.deliveryAddress || 'N/A')}`
        ]
        : [
            `<b>Pickup time:</b> ${escapeTelegram(order.pickupTime || order.deliverySlot || 'Not specified')}`
        ];
    const note = order.orderNotes || order.order_notes ? `\n<b>Note:</b> ${escapeTelegram(order.orderNotes || order.order_notes)}` : '';
    const gift = order.isGift ? `\n<b>Gift recipient:</b> ${escapeTelegram(order.giftDetails?.recipientName || 'N/A')}\n<b>Recipient phone:</b> ${escapeTelegram(order.giftDetails?.recipientPhone || 'N/A')}${order.giftDetails?.message ? `\n<b>Gift message:</b> ${escapeTelegram(order.giftDetails.message)}` : ''}` : '';
    const message = [
        "<b>New Paid Order - Mayschills</b>",
        `<b>Order:</b> MCH-${escapeTelegram(String(order.id).slice(-8))}`,
        `<b>Customer:</b> ${escapeTelegram(order.customerName || 'Guest Customer')}`,
        `<b>Phone:</b> ${escapeTelegram(order.deliveryPhone || 'N/A')}`,
        ...extraDetails,
        '', '<b>Items</b>', buildItemsText(order.items, true), '',
        `<b>Subtotal:</b> NGN${Number(order.subtotal || 0).toLocaleString()}`,
        `<b>Delivery:</b> NGN${Number(order.deliveryFee || 0).toLocaleString()}`,
        `<b>Total:</b> NGN${Number(order.total || 0).toLocaleString()}`,
        `<b>Fulfilment:</b> ${escapeTelegram(order.type || 'N/A')}`,
        `<b>Time:</b> ${escapeTelegram(order.deliverySlot || order.pickupTime || 'Not specified')}`,
        note, gift
    ].join('\n');
    const chunks = message.match(/[\s\S]{1,3900}(?:\n|$)/g) || [message];
    for (const chunk of chunks) {
        const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: chunk, parse_mode: 'HTML' })
        });
        if (!response.ok) return false;
    }
    return true;
}

function lagosParts(date = new Date()) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos', year: 'numeric', month: '2-digit', day: '2-digit' })
        .formatToParts(date).reduce((out, part) => ({ ...out, [part.type]: part.value }), {});
}

function lagosTimeToday(hour, minute, dayOffset = 0) {
    const parts = lagosParts();
    return new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + dayOffset, hour, minute) - 60 * 60 * 1000);
}

function requestedFulfillment(metadata) {
    if (metadata.requestedFulfillmentAt && !Number.isNaN(Date.parse(metadata.requestedFulfillmentAt))) return new Date(metadata.requestedFulfillmentAt);
    const time = String(metadata.pickupTimeValue || metadata.pickupTime || '').match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
    if (time) {
        let hour = Number(time[1]); const minute = Number(time[2]); const period = String(time[3] || '').toUpperCase();
        if (period === 'PM' && hour < 12) hour += 12; if (period === 'AM' && hour === '12') hour = 0;
        let result = lagosTimeToday(hour, minute);
        if (result.getTime() < Date.now()) result = lagosTimeToday(hour, minute, 1);
        return result;
    }
    const slot = String(metadata.deliverySlotKey || '');
    if (slot === 'morning') return lagosTimeToday(13, 30);
    if (slot === 'afternoon') return lagosTimeToday(18, 0);
    if (slot === 'next_day_morning') return lagosTimeToday(13, 30, 1);
    return null;
}

function scheduleFor(metadata) {
    const requested = requestedFulfillment(metadata);
    const now = Date.now();
    let dispatchAt = null;
    if (metadata.orderType === 'delivery') {
        if (metadata.deliverySlotKey === 'morning') dispatchAt = lagosTimeToday(10, 0);
        if (metadata.deliverySlotKey === 'afternoon') dispatchAt = lagosTimeToday(15, 0);
        if (metadata.deliverySlotKey === 'next_day_morning') dispatchAt = lagosTimeToday(10, 0, 1);
    }
    if (dispatchAt && dispatchAt.getTime() <= now) dispatchAt = new Date(now + 17 * 60 * 1000);
    const preparationStart = dispatchAt || (requested && requested.getTime() > now + 30 * 60 * 1000
        ? new Date(requested.getTime() - 17 * 60 * 1000)
        : new Date(now + 17 * 60 * 1000));
    return { requested, dispatchAt, readyTarget: preparationStart };
}

async function sendOrderPush(order, message) {
    if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY || !process.env.VAPID_SUBJECT || !pool) return false;
    webpush.setVapidDetails(process.env.VAPID_SUBJECT, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
    const email = order.customerEmail || order.customer_email;
    const reference = order.paymentReference || order.payment_reference;
    const result = await pool.query('SELECT endpoint, subscription FROM push_subscriptions WHERE order_reference = $1 OR (order_reference IS NULL AND customer_email = $2)', [reference, email]);
    let sent = false;
    for (const row of result.rows) {
        try {
            await webpush.sendNotification(row.subscription, JSON.stringify({
                title: "Your Mayschills order",
                body: message,
                reference: order.paymentReference || order.payment_reference
            }));
            sent = true;
        } catch (error) {
            if (error.statusCode === 404 || error.statusCode === 410) await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [row.endpoint]);
            else console.error('Push notification failed:', error.message);
        }
    }
    return sent;
}

async function sendManagerReminder(order) {
    if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) return false;
    const target = order.ready_target_at ? new Date(order.ready_target_at).toLocaleString('en-NG', { timeZone: 'Africa/Lagos' }) : 'now';
    const dispatch = order.dispatch_at ? new Date(order.dispatch_at).toLocaleString('en-NG', { timeZone: 'Africa/Lagos' }) : 'not batched';
    const deliveryInfo = order.order_type === 'delivery'
        ? `\n<b>Delivery area:</b> ${order.delivery_area || 'N/A'}\n<b>Delivery address:</b> ${order.delivery_address || 'N/A'}`
        : `\n<b>Pickup time:</b> ${order.delivery_slot || order.requested_fulfillment_at ? new Date(order.delivery_slot || order.requested_fulfillment_at).toLocaleString('en-NG', { timeZone: 'Africa/Lagos' }) : 'Not specified'}`;
    const message = `<b>Action required: order preparation</b>\n<b>Order:</b> MCH-${String(order.payment_reference).slice(-8)}\n<b>Customer:</b> ${order.customer_name || 'Customer'}\n<b>Phone:</b> ${order.delivery_phone || 'N/A'}${deliveryInfo}\n<b>Preparation target:</b> ${target}\n<b>Dispatch batch:</b> ${dispatch}\n<b>Status:</b> ${order.order_status || 'received'}\n\nThe order should be in preparation now. Update its status in the admin panel.`;
    const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML' }) });
    return response.ok;
}

async function processScheduledNotifications() {
    if (!pool) return;
    const due = await pool.query(`SELECT * FROM orders WHERE ready_target_at IS NOT NULL AND order_status NOT IN ('delivered','picked_up','cancelled') AND NOW() >= ready_target_at`);
    for (const order of due.rows) {
        if (!order.manager_reminded_at) {
            await sendManagerReminder(order);
            await pool.query('UPDATE orders SET manager_reminded_at=NOW() WHERE payment_reference=$1 AND manager_reminded_at IS NULL', [order.payment_reference]);
        }
        if (!order.customer_reminded_at) {
            await sendOrderPush(order, `Hello ${String(order.customer_name || 'there').trim().split(/\s+/)[0]}, we have started preparing your order. We will let you know as soon as it is ready.`);
            await pool.query('UPDATE orders SET customer_reminded_at=NOW() WHERE payment_reference=$1 AND customer_reminded_at IS NULL', [order.payment_reference]);
        }
    }
}

async function saveOrder(order) {
    if (!pool) throw new Error('DATABASE_URL is required');
    const result = await pool.query(`
        INSERT INTO orders (
            payment_reference, customer_name, customer_email, delivery_phone, order_type,
            delivery_address, delivery_area, delivery_slot, order_notes, items,
            subtotal, delivery_fee, total, is_gift, gift_details, requested_fulfillment_at, dispatch_at, ready_target_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15::jsonb,$16,$17,$18)
        ON CONFLICT (payment_reference) DO UPDATE SET
            customer_name = EXCLUDED.customer_name,
            customer_email = EXCLUDED.customer_email,
            delivery_phone = EXCLUDED.delivery_phone,
            order_type = EXCLUDED.order_type,
            delivery_address = EXCLUDED.delivery_address,
            delivery_area = EXCLUDED.delivery_area,
            delivery_slot = EXCLUDED.delivery_slot,
            order_notes = EXCLUDED.order_notes,
            items = EXCLUDED.items,
            subtotal = EXCLUDED.subtotal,
            delivery_fee = EXCLUDED.delivery_fee,
            total = EXCLUDED.total,
            is_gift = EXCLUDED.is_gift,
            gift_details = EXCLUDED.gift_details,
            requested_fulfillment_at = COALESCE(orders.requested_fulfillment_at, EXCLUDED.requested_fulfillment_at),
            dispatch_at = COALESCE(orders.dispatch_at, EXCLUDED.dispatch_at),
            ready_target_at = COALESCE(orders.ready_target_at, EXCLUDED.ready_target_at)
        RETURNING *
    `, [
        order.paymentReference, order.customerName, order.customerEmail, order.deliveryPhone,
        order.type, order.deliveryAddress, order.deliveryArea, order.deliverySlot,
        order.orderNotes, JSON.stringify(order.items), order.subtotal, order.deliveryFee, order.total,
        Boolean(order.isGift), JSON.stringify(order.giftDetails || {}), order.requestedFulfillmentAt, order.dispatchAt, order.readyTargetAt
    ]);
    return result.rows[0];
}

async function markNotification(status, reference) {
    if (!pool) return;
    await pool.query('UPDATE orders SET notification_status = $1, notified_at = CASE WHEN $1 = $2 THEN NOW() ELSE notified_at END WHERE payment_reference = $3', [status, 'sent', reference]);
}

app.post('/webhook', async (request, response) => {
    const rawBody = request.rawBody || Buffer.from(JSON.stringify(request.body || {}));
    if (!verifyPaystackSignature(request, rawBody)) return response.sendStatus(401);
    try {
        const payload = JSON.parse(rawBody.toString('utf8'));
        if (payload.event !== 'charge.success' && payload.data?.status !== 'success') return json(response, 200, { received: true });
        const payment = payload.data || payload;
        const metadata = payment.metadata || {};
        const items = normalizeOrderItems(metadata.items || metadata.cartItems || []);
        const schedule = scheduleFor(metadata);
        const customerName = [payment.customer?.first_name, payment.customer?.last_name].filter(Boolean).join(' ') || metadata.customerName || 'Customer';
        const order = {
            id: payment.reference || 'UNKNOWN',
            paymentReference: payment.reference,
            customerEmail: payment.customer?.email || metadata.customerEmail || 'unknown@example.com',
            customerName,
            deliveryPhone: payment.customer?.phone || metadata.deliveryPhone || 'N/A',
            items,
            subtotal: Number(metadata.subtotal || 0),
            deliveryFee: Number(metadata.deliveryFee || 0),
            total: Number(payment.amount || 0) / 100,
            type: metadata.orderType || 'pickup',
            deliveryAddress: metadata.deliveryAddress,
            deliveryArea: metadata.deliveryArea,
            deliverySlot: metadata.deliverySlot,
            pickupTime: metadata.pickupTime,
            orderNotes: metadata.orderNotes,
            isGift: Boolean(metadata.isGift),
            giftDetails: metadata.giftDetails || {},
            sharedCartToken: metadata.sharedCartToken || null,
            requestedFulfillmentAt: schedule.requested,
            dispatchAt: schedule.dispatchAt,
            readyTargetAt: schedule.readyTarget,
            date: new Date().toISOString()
        };
        await saveOrder(order);
        if (order.sharedCartToken) await pool.query("UPDATE shared_carts SET status = 'paid' WHERE token = $1 AND status = 'awaiting_payment'", [order.sharedCartToken]);
        const claim = await pool.query(`
            UPDATE orders SET notification_status = 'sending'
            WHERE payment_reference = $1 AND notification_status IN ('pending', 'not_configured')
            RETURNING payment_reference
        `, [order.paymentReference]);
        if (claim.rowCount) {
            const [email, telegram] = await Promise.all([sendEmail(order), sendTelegram(order)]);
            await sendOrderPush(order, `Thank you, ${String(order.customer_name || 'there').trim().split(/\s+/)[0]}. Your payment was received and your order is now in our queue.`);
            const notificationStatus = email || telegram ? 'sent' : 'not_configured';
            await markNotification(notificationStatus, order.paymentReference);
            return json(response, 200, { success: true, emailSent: email, telegramSent: telegram, orderId: order.id });
        }
        return json(response, 200, { success: true, duplicate: true, orderId: order.id });
    } catch (error) {
        console.error('Webhook error:', error);
        return json(response, 500, { success: false, error: 'Webhook processing failed' });
    }
});

initializeDatabase()
    .then(() => app.listen(port, () => { console.log(`Mayschills backend listening on ${port}`); setInterval(() => processScheduledNotifications().catch(error => console.error('Scheduled notification processing failed:', error)), 60 * 1000); }))
    .catch(error => { console.error('Database initialization failed:', error); process.exit(1); });
