# Render Webhook Setup - May's Chills

## ⚡ Quick Deploy (5 minutes)

### Step 1: Deploy the backend

1. Create a Render **Web Service** from this repository.
2. Set **Root Directory** to `backend`.
3. Set **Build Command** to `npm install`.
4. Set **Start Command** to `npm start`.
5. Add a Render PostgreSQL database and expose its `DATABASE_URL` to the service.
6. Copy the backend URL, for example `https://mayschillsbackend.onrender.com`.
7. Add `PAYSTACK_SECRET`, `ADMIN_PASSWORD`, `ADMIN_SESSION_SECRET`, and `FRONTEND_URL` in Render Environment.
8. Add the email and/or Telegram variables listed below for live notifications.
9. For browser push notifications, run `npx web-push generate-vapid-keys` from the backend folder and add `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` to Render. Never expose the private key.

The backend calculates preparation reminders from the selected pickup time or delivery slot. Keep the Render service running so its scheduled notification worker can send manager and customer reminders at the correct time.

### Step 2: Configure Paystack Webhook

1. Go to **https://dashboard.paystack.com**
2. Click **Settings → Webhooks** (or API Keys & Webhooks)
3. In the **Webhook URL** field, paste:
   ```
   https://mayschillsbackend.onrender.com/webhook
   ```
4. Select Events: Check only **`charge.success`**
5. Click **Save**

### Step 3: Test the Webhook

1. Open your Render Web Service logs
2. Make a test payment in your shop
3. Confirm the backend logs show a successful webhook
4. You should see:
   - ✅ Email notification sent
   - ✅ Telegram notification sent

### Step 4: Configure the frontend

Set the backend URL fallback in `admin.html`, `shop.html`, and `checkout.html` to your actual Render backend URL:

```javascript
const API_BASE = 'https://mayschillsbackend.onrender.com';
```

---

## 🔧 Configuration Details

Add these values as Render Web Service environment variables. Do not put credentials in frontend files:

| Setting | Value |
|---------|-------|
| **Business Email** | `BUSINESS_EMAIL` |
| **EmailJS Service** | `EMAILJS_SERVICE` |
| **EmailJS Template** | `EMAILJS_TEMPLATE` |
| **EmailJS Public Key** | `EMAILJS_KEY` |
| **Telegram Bot Token** | `TELEGRAM_BOT_TOKEN` |
| **Telegram Chat ID** | `TELEGRAM_CHAT_ID` |
| **Paystack Secret Key** | `PAYSTACK_SECRET` |

### Uber Direct delivery pricing

Add these Render environment variables from the Uber Direct Developer Dashboard. Keep the client secret server-side:

| Setting | Value |
|---------|-------|
| **Uber Client ID** | `UBER_CLIENT_ID` |
| **Uber Client Secret** | `UBER_CLIENT_SECRET` |
| **Uber Customer ID** | `UBER_CUSTOMER_ID` |
| **Store pickup address** | `UBER_PICKUP_ADDRESS` (optional JSON override; defaults to Mayschills, 16 Adeola Raji Avenue, Atunrase Estate, Lagos, Nigeria) |
| **Drop-off city** | `UBER_DROP_OFF_CITY` (optional, defaults to Lagos) |
| **Drop-off state** | `UBER_DROP_OFF_STATE` (optional, defaults to Lagos) |
| **Drop-off country** | `UBER_DROP_OFF_COUNTRY` (optional, defaults to NG) |

Example `UBER_PICKUP_ADDRESS` value:

```json
{"street_address":["Mayschills","16 Adeola Raji Avenue","Atunrase Estate"],"city":"Lagos","state":"Lagos","country":"NG"}
```

The checkout calls `POST /api/delivery/quote` after the customer enters an address. Uber Direct uses OAuth client credentials and returns the quote fee in the account currency. Uber’s Direct API access and production delivery availability may require approval; test credentials use Uber’s sandbox.

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

- ✅ Keep secrets private and configure them in Render, not in source control
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
