# May's Chills admin setup

The admin panel is available at `/admin.html` (or `/admin` if the host is configured to remove `.html`). It is protected by the Worker API, not by a password stored in the page.

## Render backend

Create a Render Web Service with these settings:

```text
Root Directory: backend
Build Command: npm install
Start Command: npm start
```

Set `FRONTEND_URL` to the deployed Render Static Site URL. The frontend pages use `MAYCHILLS_API_URL` when present, otherwise they use `https://mayschills-backend.onrender.com`; replace that fallback with your actual backend URL if your Render service has a different name.

Create a Render PostgreSQL database and set its `DATABASE_URL` on the Web Service. The backend creates the availability and orders tables on startup. Paid orders appear in the admin dashboard after Paystack confirms them.

## API requirements

Add these Render Web Service environment variables:

- `ADMIN_PASSWORD`: a long password used at `/admin.html`
- `ADMIN_SESSION_SECRET`: a different long random value used to sign admin sessions
- `PAYSTACK_SECRET`: Paystack secret key, used only to verify signed webhooks
- `FRONTEND_URL`: exact deployed frontend origin, for example `https://mayschills.com`
- `EMAILJS_SERVICE`, `EMAILJS_TEMPLATE`, `EMAILJS_KEY`, `BUSINESS_EMAIL`: optional email notification settings
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`: optional Telegram notification settings

The Render backend routes these endpoints:

- `GET /api/availability` — public menu status used by the storefront
- `POST /api/admin/login` — protected login endpoint
- `POST /api/availability` — protected enable/disable endpoint

After changing secrets, redeploy the Web Service. Existing browser sessions expire after eight hours.

The “rest of today” option expires at the next midnight in Africa/Lagos. “Until re-enabled” remains off until the Enable button is pressed. This includes every product and every paid extra in the catalog.
