# May's Chills admin setup

The admin panel is available at `/admin.html` (or `/admin` if the host is configured to remove `.html`). It is protected by the Worker API, not by a password stored in the page.

## Cloudflare Worker

Create a KV namespace and bind it to the Worker with the variable name `MAYCHILLS_KV`. Add these Worker secrets:

- `ADMIN_PASSWORD`: the password used at `/admin.html`
- `ADMIN_SESSION_SECRET`: a long random value used to sign admin sessions (recommended)

The Worker routes these endpoints:

- `GET /api/availability` — public menu status used by the storefront
- `POST /api/admin/login` — protected login endpoint
- `POST /api/availability` — protected enable/disable endpoint

Set the Worker route so the API is on the same origin as the website. For Wrangler, the binding is equivalent to:

```toml
[[kv_namespaces]]
binding = "MAYCHILLS_KV"
id = "your-kv-namespace-id"
```

After changing `ADMIN_PASSWORD` or `ADMIN_SESSION_SECRET`, deploy the Worker again. Existing browser sessions expire after eight hours.

The “rest of today” option expires at the next midnight in Africa/Lagos. “Until re-enabled” remains off until the Enable button is pressed. This includes every product and every paid extra in the catalog.
