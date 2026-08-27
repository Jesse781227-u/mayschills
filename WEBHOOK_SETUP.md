# Cloudflare Worker Webhook Setup - May's Chills

## ⚡ Quick Deploy (5 minutes)

### Step 1: Deploy the Worker

1. Go to **https://workers.cloudflare.com**
2. Sign in or create free account
3. Click **"Create a Service"**
4. Name it: `mays-chills-webhook`
5. Click **"Create Service"**
6. Replace ALL the code with the code from `cloudflare-worker.js`
7. Click **"Deploy"**
8. **Copy your Worker URL** (looks like: `https://mays-chills-webhook.yourname.workers.dev`)

### Step 2: Configure Paystack Webhook

1. Go to **https://dashboard.paystack.com**
2. Click **Settings → Webhooks** (or API Keys & Webhooks)
3. In the **Webhook URL** field, paste:
   ```
   https://mays-chills-webhook.yourname.workers.dev/webhook
   ```
4. Select Events: Check only **`charge.success`**
5. Click **Save**

### Step 3: Test the Webhook

1. Back in Cloudflare Workers, click your worker
2. Go to **"Real-time logs"** tab
3. Make a test payment in your shop
4. You should see logs appear with:
   - ✅ Email notification sent
   - ✅ Telegram notification sent

### Step 4: Update shop.html

Replace the Cloudflare Worker URL in your `shop.html` file (around line 5000):

```javascript
const WEBHOOK_URL = 'https://mays-chills-webhook.yourname.workers.dev/webhook';
```

---

## 🔧 Configuration Details

Add these values as Cloudflare Worker secrets or environment variables. Do not put credentials in `cloudflare-worker.js`:

| Setting | Value |
|---------|-------|
| **Business Email** | `BUSINESS_EMAIL` |
| **EmailJS Service** | `EMAILJS_SERVICE` |
| **EmailJS Template** | `EMAILJS_TEMPLATE` |
| **EmailJS Public Key** | `EMAILJS_KEY` |
| **Telegram Bot Token** | `TELEGRAM_BOT_TOKEN` |
| **Telegram Chat ID** | `TELEGRAM_CHAT_ID` |
| **Paystack Secret Key** | `PAYSTACK_SECRET` |

---

## 🧪 Testing

### Via Paystack Dashboard:
1. Go to **Settings → Webhooks**
2. Find your webhook entry
3. Click the **"Test"** button
4. Check your Telegram and email

### Via Real Payment:
1. Make a test purchase
2. Check:
   - ✅ Email received at 0xjave@gmail.com
   - ✅ Telegram message in your chat

---

## 📝 Troubleshooting

| Issue | Solution |
|-------|----------|
| No Telegram message | Check bot token is correct in the Worker |
| No email | Verify EmailJS credentials are right |
| Worker returns error | Check Paystack payload structure |
| 404 Not Found | Make sure URL ends with `/webhook` |

---

## 🔐 Security Notes

- ✅ Keep Worker secrets private and configure them in Cloudflare, not in source control
- ✅ Paystack only sends webhooks from verified IPs
- ✅ Future: Add HMAC signature verification for extra security

---

## 💾 Webhook Response

When a payment is received, the Worker:
1. ✅ Verifies it's a successful charge
2. ✅ Sends email to your business
3. ✅ Sends Telegram to your admin chat
4. ✅ Returns `200 OK` to Paystack

---

## 🚀 You're all set!

Your webhook is now live and will automatically notify you via email and Telegram when customers make purchases.
