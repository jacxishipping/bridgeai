# Remote access
- Devices connect OUTBOUND to the control plane (agent polling). No
  inbound port is needed on a device, and no inbound shell is ever opened.
- The plane itself should sit behind a TLS reverse proxy (nginx example):
  ```
  server {
    listen 443 ssl; server_name bridge.example.com;
    ssl_certificate /etc/letsencrypt/live/bridge.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/bridge.example.com/privkey.pem;
    location / { proxy_pass http://127.0.0.1:8000; proxy_set_header Host $host; }
  }
  ```
  Obtain certs with certbot. Keep :8000 on loopback only.
- Authentication: admin dashboard/API via `X-Admin-Token`; devices via
  `X-Device-Token` (hashed at rest). Rotate both on any suspected leak.
- MCP remote: run `python -m ai_bridge.server --http` on loopback and
  proxy it with TLS + a bearer check; never expose the raw HTTP MCP port.
- Offline devices: tasks stay `queued`; the agent picks them up on
  reconnect with bounded exponential backoff (2s -> 60s cap). The
  dashboard shows last-seen from heartbeats.

- mTLS: terminate TLS at nginx with `ssl_verify_client on;` and a client
  CA, and only then proxy to the loopback plane. Plane-side device mTLS:
  code present, end-to-end verification pending. The fingerprint gate is
  in-tree and env-gated (`AI_BRIDGE_DEVICE_MTLS=1`,
  `control/device_mtls.py`); the fingerprint is taken from reverse-proxy
  headers, so enforcement depends on TLS termination at the proxy — the
  plane does not verify client certificates itself.
