import crypto from 'node:crypto';
import express from 'express';
import pg from 'pg';

const { Pool } = pg;
const app = express();
const port = Number(process.env.PORT || 3000);
const frontendUrl = process.env.FRONTEND_URL || '*';
const pool = process.env.DATABASE_URL
    ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
    : null;

app.use(express.json({
    limit: '1mb',
    verify: (request, _response, buffer) => { request.rawBody = Buffer.from(buffer); }
}));
app.use((request, response, next) => {
    response.header('Access-Control-Allow-Origin', frontendUrl);
    response.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;
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

app.get('/api/availability', async (_request, response) => {
    try {
        return json(response, 200, { items: await readAvailability() });
    } catch (error) {
        console.error('Availability read failed:', error);
        return json(response, 500, { error: 'Unable to read availability' });
    }
});

app.post('/api/admin/login', (request, response) => {
    const { password } = request.body || {};
    if (!process.env.ADMIN_PASSWORD || password !== process.env.ADMIN_PASSWORD) {
        return json(response, 401, { error: 'Invalid password' });
    }
    const token = signAdminToken({ role: 'admin', exp: Date.now() + 8 * 60 * 60 * 1000 });
    return json(response, 200, { token });
});

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

function verifyPaystackSignature(request, rawBody) {
    const signature = request.headers['x-paystack-signature'];
    const secret = process.env.PAYSTACK_SECRET;
    if (!signature || !secret) return false;
    const expected = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

function formatCustomizationLines(item) {
    const customizations = item.customizations || {};
    const lines = [];
    (customizations.removed || []).forEach(id => lines.push(`Removed: ${id}`));
    Object.entries(customizations.substitutions || {}).forEach(([from, to]) => lines.push(`Substitute: ${from} -> ${to}`));
    (customizations.additions || []).forEach(addition => {
        const quantity = Number(addition.quantity || 1);
        const price = Number(addition.price || 0) * quantity;
        lines.push(`Added: ${quantity > 1 ? `${quantity}x ` : ''}${addition.name || addition.id}${price ? ` +NGN${price.toLocaleString()}` : ''}`);
    });
    return lines;
}

function buildItemsText(items) {
    return items.map(item => {
        const total = Number(item.price || 0) * Number(item.quantity || 0);
        const details = formatCustomizationLines(item).map(line => `\n  - ${line}`).join('');
        return `${item.quantity}x ${item.name} - NGN${total.toLocaleString()}${details}`;
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
                to_name: "MAY'S CHILLS",
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
                order_date: order.date
            }
        })
    });
    return response.ok;
}

async function sendTelegram(order) {
    if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) return false;
    const message = [
        "<b>New Paid Order - May's Chills</b>",
        `<b>Order:</b> MCH-${String(order.id).slice(-8)}`,
        `<b>Customer:</b> ${order.customerName || 'Guest Customer'}`,
        `<b>Phone:</b> ${order.deliveryPhone || 'N/A'}`,
        '', '<b>Items</b>', buildItemsText(order.items), '',
        `<b>Subtotal:</b> NGN${Number(order.subtotal || 0).toLocaleString()}`,
        `<b>Delivery:</b> NGN${Number(order.deliveryFee || 0).toLocaleString()}`,
        `<b>Total:</b> NGN${Number(order.total || 0).toLocaleString()}`,
        `<b>Fulfilment:</b> ${order.type || 'N/A'}`,
        `<b>Time:</b> ${order.deliverySlot || order.pickupTime || 'Not specified'}`
    ].join('\n');
    const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML' })
    });
    return response.ok;
}

app.post('/webhook', async (request, response) => {
    const rawBody = request.rawBody || Buffer.from(JSON.stringify(request.body || {}));
    if (!verifyPaystackSignature(request, rawBody)) return response.sendStatus(401);
    try {
        const payload = JSON.parse(rawBody.toString('utf8'));
        if (payload.event !== 'charge.success' && payload.data?.status !== 'success') return json(response, 200, { received: true });
        const payment = payload.data || payload;
        const metadata = payment.metadata || {};
        const items = metadata.items || metadata.cartItems || [];
        const order = {
            id: payment.reference || 'UNKNOWN',
            paymentReference: payment.reference,
            customerEmail: payment.customer?.email || 'unknown@example.com',
            customerName: payment.customer?.first_name || 'Customer',
            deliveryPhone: payment.customer?.phone || 'N/A',
            items: Array.isArray(items) ? items : [],
            subtotal: Number(metadata.subtotal || 0),
            deliveryFee: Number(metadata.deliveryFee || 0),
            total: Number(payment.amount || 0) / 100,
            type: metadata.orderType || 'pickup',
            deliveryAddress: metadata.deliveryAddress,
            deliveryArea: metadata.deliveryArea,
            deliverySlot: metadata.deliverySlot,
            pickupTime: metadata.pickupTime,
            date: new Date().toISOString()
        };
        const [email, telegram] = await Promise.all([sendEmail(order), sendTelegram(order)]);
        return json(response, 200, { success: true, emailSent: email, telegramSent: telegram, orderId: order.id });
    } catch (error) {
        console.error('Webhook error:', error);
        return json(response, 500, { success: false, error: 'Webhook processing failed' });
    }
});

initializeDatabase()
    .then(() => app.listen(port, () => console.log(`May's Chills backend listening on ${port}`)))
    .catch(error => { console.error('Database initialization failed:', error); process.exit(1); });
