# Test OIDC provider (staging only)

A minimal Dex instance used ONLY to prove the plane's OIDC exchange-code
flow works across workers on staging. It is not production auth:

- one hardcoded test user (`test@staging.local`, bcrypt hash supplied at
  deploy time — the password lives only in
  `~/workspace/tmp/test-idp-credentials.json` on the operator VM, never
  committed),
- in-memory storage (restart loses codes/sessions),
- no TLS of its own (Render terminates TLS),
- NO secret is committed: `dex.yaml` carries `__CLIENT_SECRET__` /
  `__PASSWORD_HASH__` placeholders, filled at container start from the
  service environment (`DEX_CLIENT_SECRET`, `DEX_TEST_PASSWORD_HASH`).

Deploy: Render web service `ai-bridge-test-idp`, free plan, Docker,
repo `jacxishipping/bridgeai`, branch `main`,
dockerfilePath `scripts/test-idp/Dockerfile`, dockerContext `.`,
env `DEX_CLIENT_SECRET` + `DEX_TEST_PASSWORD_HASH` (from
`test-idp-credentials.json`).
Issuer: `https://ai-bridge-test-idp.onrender.com`.
Plane env (set via Render, merge mode — triggers a plane redeploy):
`AI_BRIDGE_OIDC_ISSUER=https://ai-bridge-test-idp.onrender.com`,
`AI_BRIDGE_OIDC_CLIENT_ID=ai-bridge-staging`,
`AI_BRIDGE_OIDC_CLIENT_SECRET=<from test-idp-credentials.json>`,
`AI_BRIDGE_OIDC_REDIRECT_URI=https://ai-bridge-staging-plane.onrender.com/api/auth/oidc/callback`,
`AI_BRIDGE_OIDC_DASHBOARD_URL=https://ai-bridge-staging-plane.onrender.com/`.
