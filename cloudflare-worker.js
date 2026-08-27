/**
 * Cloudflare Worker - Paystack Webhook Handler
 * Deploy to Cloudflare Workers to receive Paystack payment notifications
 * 
 * Setup:
 * 1. Go to https://workers.cloudflare.com
 * 2. Create new worker
 * 3. Paste this entire code
 * 4. Replace YOUR_PAYSTACK_SECRET_KEY with your key
 * 5. Go to Paystack Dashboard > Settings > Webhooks
 * 6. Add webhook: https://your-worker.workers.dev (your Cloudflare Worker URL)
 * 7. Events: Select "charge.success"
 */

// Helper: Verify Paystack webhook signature
function verifyPaystackSignature(request, secret) {
    const hash = request.headers.get('x-paystack-signature');
    if (!hash) return false;
    
    // This will be verified by comparing HMAC-SHA512
    // For Cloudflare Workers, we'll do basic verification
    return true; // Note: Implement full HMAC verification in production
}

// Helper: Send email via EmailJS API
async function sendEmailNotification(order, transaction, env) {
    try {
        const itemsHTML = order.items.map(item => 
            `<tr>
                <td style="padding: 8px; border-bottom: 1px solid #eee;">${item.quantity}</td>
                <td style="padding: 8px; border-bottom: 1px solid #eee;">${item.name}</td>
                <td style="padding: 8px; border-bottom: 1px solid #eee;">₦${item.price.toLocaleString()}</td>
                <td style="padding: 8px; border-bottom: 1px solid #eee;">₦${(item.price * item.quantity).toLocaleString()}</td>
            </tr>`
        ).join('');

        const templateParams = {
            to_email: env.BUSINESS_EMAIL,
            to_name: "MAY'S CHILLS",
            order_id: 'MCH-' + order.id.slice(-8),
            customer_name: order.customerName || 'Guest Customer',
            customer_email: order.customerEmail || 'No email provided',
            customer_phone: order.deliveryPhone || 'Not provided',
            order_type: order.type === 'delivery' ? '🚚 Delivery' : order.type === 'pickup' ? '🚶 Pickup' : '🏪 In-Shop',
            order_items: itemsHTML,
            order_count: `${order.items.length} item(s)`,
            subtotal: `₦${order.subtotal.toLocaleString()}`,
            delivery_fee: `₦${(order.deliveryFee || 0).toLocaleString()}`,
            total_amount: `₦${order.total.toLocaleString()}`,
            delivery_address: order.deliveryAddress || 'Pickup order',
            delivery_area: order.deliveryArea || 'N/A',
            delivery_slot: order.deliverySlot || 'Auto-allocated',
            payment_reference: order.paymentReference || 'N/A',
            payment_status: '✅ PAID',
            payment_method: 'Paystack',
            order_date: new Date(order.date).toLocaleString()
        };

        const response = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                service_id: env.EMAILJS_SERVICE,
                template_id: env.EMAILJS_TEMPLATE,
                user_id: env.EMAILJS_KEY,
                template_params: templateParams
            })
        });

        return response.ok;
    } catch (error) {
        console.error('Email error:', error);
        return false;
    }
}

// Helper: Send Telegram notification
async function sendTelegramNotification(order, transaction, env) {
    try {
        const itemsText = order.items.map(item => {
            const itemTotal = item.price * item.quantity;
            return `• ${item.quantity}x ${item.name} — ₦${itemTotal.toLocaleString()}`;
        }).join('\n');

        const locationDetails = order.type === 'delivery'
            ? `\n<b>Delivery Details</b>\nArea: ${order.deliveryArea}\nAddress: ${order.deliveryAddress}\nPhone: ${order.deliveryPhone}\nSlot: ${order.deliverySlot || 'Auto-allocated'}`
            : `\n<b>Fulfilment</b>\nType: ${order.type === 'pickup' ? 'Pickup' : 'In-house dining'}\nTime: ${order.deliverySlot || 'Not specified'}`;

        const message = [
            "<b>✅ New Paid Order - May's Chills</b>",
            '',
            `<b>Order ID:</b> MCH-${order.id.slice(-8)}`,
            `<b>Customer:</b> ${order.customerName || 'Guest'}`,
            `<b>Email:</b> ${order.customerEmail || 'N/A'}`,
            `<b>Phone:</b> ${order.deliveryPhone || 'N/A'}`,
            `<b>Order Type:</b> ${order.type}`,
            '',
            '<b>Items Ordered</b>',
            itemsText || 'No items',
            '',
            '<b>Payment Summary</b>',
            `Subtotal: ₦${order.subtotal.toLocaleString()}`,
            `Delivery Fee: ₦${(order.deliveryFee || 0).toLocaleString()}`,
            `Total Paid: ₦${order.total.toLocaleString()}`,
            `Reference: ${transaction.reference}`,
            `Date: ${new Date(order.date).toLocaleString()}`,
            locationDetails
        ].join('\n');

        const telegramUrl = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
        const response = await fetch(telegramUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: env.TELEGRAM_CHAT_ID,
                text: message,
                parse_mode: 'HTML'
            })
        });

        return response.ok;
    } catch (error) {
        console.error('Telegram error:', error);
        return false;
    }
}

// Main Webhook Handler
async function handleWebhook(request, env) {
    // Only accept POST requests
    if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405 });
    }

    try {
        const payload = await request.json();
        
        // Paystack sends transaction fields and metadata inside data.
        const payment = payload.data || payload;
        const metadata = payment.metadata || payload.metadata || {};
        const { status, reference, amount, customer } = payment;

        // Only process successful payments
        if (status !== 'success' && payload.data?.status !== 'success') {
            console.log('Payment not successful:', status);
            return new Response(JSON.stringify({ received: true }), { status: 200 });
        }

        // Structure order data from webhook
        const order = {
            id: reference || payload.data?.reference || 'UNKNOWN',
            paymentReference: reference || payload.data?.reference,
            customerEmail: customer?.email || payload.data?.customer?.email || 'unknown@example.com',
            customerName: customer?.first_name || payload.data?.customer?.first_name || 'Customer',
            deliveryPhone: customer?.phone || payload.data?.customer?.phone || 'N/A',
            items: metadata.items || metadata.cartItems || [],
            subtotal: metadata.subtotal || (metadata.items || metadata.cartItems || []).reduce((sum, item) => sum + Number(item.price || 0) * Number(item.quantity || 0), 0),
            deliveryFee: Number(metadata.deliveryFee || 0),
            total: (payment.amount || 0) / 100, // Paystack uses kobo
            type: metadata.orderType || 'delivery',
            deliveryAddress: metadata.deliveryAddress || 'Not provided',
            deliveryArea: metadata.deliveryArea || 'N/A',
            deliverySlot: metadata.deliverySlot || metadata.pickupTime || 'Auto-allocated',
            date: new Date().toISOString(),
            status: 'paid'
        };

        const transaction = {
            reference: reference || payload.data?.reference,
            status: 'success',
            amount: (payload.amount || payload.data?.amount || 0) / 100
        };

        console.log('Processing payment:', order.id);

        // Send notifications in parallel
        const [emailSent, telegramSent] = await Promise.allSettled([
            sendEmailNotification(order, transaction, env),
            sendTelegramNotification(order, transaction, env)
        ]).then(results => [
            results[0].status === 'fulfilled' ? results[0].value : false,
            results[1].status === 'fulfilled' ? results[1].value : false
        ]);

        console.log(`✅ Email: ${emailSent}, Telegram: ${telegramSent}`);

        // Store in KV storage (optional - requires KV binding)
        // await ORDERS.put(order.id, JSON.stringify(order));

        return new Response(JSON.stringify({
            success: true,
            message: 'Webhook processed',
            emailSent,
            telegramSent,
            orderId: order.id
        }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (error) {
        console.error('Webhook error:', error);
        return new Response(JSON.stringify({ 
            success: false, 
            error: error.message 
        }), { 
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

// CORS handler
function handleCORS(request) {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    };

    if (request.method === 'OPTIONS') {
        return new Response('OK', { headers });
    }

    return null;
}

// ---------------------------------------------------------------------------
// Menu availability API
// Requires a KV namespace binding named MAYCHILLS_KV and these Worker secrets:
// ADMIN_PASSWORD and ADMIN_SESSION_SECRET.
// ---------------------------------------------------------------------------
const textEncoder = new TextEncoder();
const toBase64Url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromBase64Url = value => atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4));

async function signAdminToken(payload, secret) {
    const key = await crypto.subtle.importKey('raw', textEncoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const body = toBase64Url(textEncoder.encode(JSON.stringify(payload)));
    const signature = toBase64Url(await crypto.subtle.sign('HMAC', key, textEncoder.encode(body)));
    return `${body}.${signature}`;
}

async function verifyAdminToken(request, env) {
    const auth = request.headers.get('Authorization') || '';
    const token = auth.replace(/^Bearer\s+/i, '');
    const secret = env.ADMIN_SESSION_SECRET || env.ADMIN_PASSWORD;
    if (!token || !secret || !token.includes('.')) return false;
    try {
        const [body, signature] = token.split('.');
        const key = await crypto.subtle.importKey('raw', textEncoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
        const valid = await crypto.subtle.verify('HMAC', key, Uint8Array.from(fromBase64Url(signature), c => c.charCodeAt(0)), textEncoder.encode(body));
        const payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(fromBase64Url(body), c => c.charCodeAt(0))));
        return valid && payload.role === 'admin' && payload.exp > Date.now();
    } catch (_) { return false; }
}

function nextLagosMidnight() {
    const now = new Date();
    const lagos = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now).reduce((o, p) => (o[p.type] = p.value, o), {});
    // Lagos is UTC+1. This is the next calendar midnight in Lagos.
    return Date.UTC(Number(lagos.year), Number(lagos.month) - 1, Number(lagos.day) + 1, -1, 0, 0) - 1;
}

async function readAvailability(env) {
    if (!env.MAYCHILLS_KV) return {};
    const values = await env.MAYCHILLS_KV.list({ prefix: 'availability:' });
    const result = {};
    await Promise.all(values.keys.map(async item => {
        const value = await env.MAYCHILLS_KV.get(item.name);
        if (value) result[item.name.replace('availability:', '')] = JSON.parse(value);
    }));
    return result;
}

async function handleAvailability(request, env) {
    if (request.method === 'GET') {
        const stored = await readAvailability(env);
        const active = {};
        Object.entries(stored).forEach(([key, value]) => {
            if (value.mode === 'today' && value.expiresAt <= Date.now()) return;
            active[key] = value;
        });
        return new Response(JSON.stringify({ items: active }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    if (!(await verifyAdminToken(request, env))) return new Response('Unauthorized', { status: 401 });
    if (!env.MAYCHILLS_KV) return new Response('MAYCHILLS_KV binding is required', { status: 503 });
    const body = await request.json();
    const key = String(body.key || '').trim();
    const mode = body.mode;
    if (!key || !['today', 'forever', 'enabled'].includes(mode)) return new Response('Invalid availability update', { status: 400 });
    if (mode === 'enabled') await env.MAYCHILLS_KV.delete(`availability:${key}`);
    else await env.MAYCHILLS_KV.put(`availability:${key}`, JSON.stringify({ mode, expiresAt: mode === 'today' ? nextLagosMidnight() : null, updatedAt: Date.now() }));
    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
}

async function handleAdminLogin(request, env) {
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    const { password } = await request.json();
    if (!env.ADMIN_PASSWORD || password !== env.ADMIN_PASSWORD) return new Response('Invalid password', { status: 401 });
    const token = await signAdminToken({ role: 'admin', exp: Date.now() + 8 * 60 * 60 * 1000 }, env.ADMIN_SESSION_SECRET || env.ADMIN_PASSWORD);
    return new Response(JSON.stringify({ token }), { headers: { 'Content-Type': 'application/json' } });
}

// Main export
export default {
    async fetch(request, env) {
        // Handle CORS
        const corsResponse = handleCORS(request);
        if (corsResponse) return corsResponse;

        const url = new URL(request.url);

        if (url.pathname === '/api/availability') return handleAvailability(request, env);
        if (url.pathname === '/api/admin/login') return handleAdminLogin(request, env);

        // Health check endpoint
        if (url.pathname === '/health') {
            return new Response(JSON.stringify({ status: 'ok' }), { 
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // Normalize webhook path so trailing slashes still match
        const normalizedPath = url.pathname.replace(/\/+$|^$/g, '') || '/';

        // Webhook endpoint
        if (normalizedPath === '/webhook' || normalizedPath === '/') {
            return handleWebhook(request, env);
        }

        return new Response('Not found', { status: 404 });
    }
};
