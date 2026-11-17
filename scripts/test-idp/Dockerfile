# Test-only OIDC provider (Dex v2.46.1) for the AI Bridge staging OIDC
# cross-worker proof. STAGING ONLY — never for production auth.
FROM ghcr.io/dexidp/dex:v2.46.1
USER root
COPY dex.yaml /etc/dex/config.yaml
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
