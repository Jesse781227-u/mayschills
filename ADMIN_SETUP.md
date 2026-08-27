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

Create a Render PostgreSQL database and set its `DATABASE_URL` on the Web Service. The backend creates its availability table on startup.

## API requirements

Create a KV namespace and bind it to the Worker with the variable name `MAYCHILLS_KV`. Add these Worker secrets:

- `ADMIN_PASSWORD`: the password used at `/admin.html`
- `ADMIN_SESSION_SECRET`: a long random value used to sign admin sessions (recommended)

The Worker routes these endpoints:

- `GET /api/availability` — public menu status used by the storefront
- `POST /api/admin/login` — protected login endpoint
- `POST /api/availability` — protected enable/disable endpoint

After changing `ADMIN_PASSWORD` or `ADMIN_SESSION_SECRET`, redeploy the Web Service. Existing browser sessions expire after eight hours.

The “rest of today” option expires at the next midnight in Africa/Lagos. “Until re-enabled” remains off until the Enable button is pressed. This includes every product and every paid extra in the catalog.
