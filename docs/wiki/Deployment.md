# Deployment

[[Home]] · related: [[Runbook]] · [[Gotchas]] · [[Auth]] · [Docker guide](../docker.md)

Coji ships a production-oriented Docker Compose stack with PostgreSQL, a
one-shot migration service, the Bun API, and an nginx-served web application.
It does not assume a particular cloud, DNS provider, reverse proxy, or object
store.

## Production stack

`docker-compose.prod.yml` enforces this startup order:

```text
db (healthy) → migrate (completed successfully) → api (healthy) → web
```

Create a deployment-only `.env` that is never committed. At minimum, set:

```dotenv
POSTGRES_PASSWORD=<strong-random-value>
BETTER_AUTH_SECRET=<strong-random-value>
BETTER_AUTH_URL=https://coji.example.com
STRIPE_API_KEY=<stripe-secret-key>
PAYMENTS_WEBHOOK_SECRET=<stripe-webhook-secret>
PAYMENTS_SUCCESS_URL=https://coji.example.com/billing?status=success
PAYMENTS_CANCEL_URL=https://coji.example.com/billing?status=cancel
```

Then build and start the stack:

```bash
docker compose --env-file .env -f docker-compose.prod.yml up -d --build
```

The production boot gate rejects Noop payments. Provider choices for images,
animation, rendering, and storage may still use Noop/local defaults for a smoke
deployment, or be configured with the variables in `.env.example`.

## Public origin and reverse proxy

Terminate TLS at a reverse proxy or load balancer and route the public origin to
the `web` service. `BETTER_AUTH_URL` must exactly match the origin opened by the
browser or Better Auth will reject requests with `Invalid origin`.

The nginx image serves the SPA and proxies `/api`, `/health`, and `/files` to the
API. If you replace nginx or split the web and API origins, preserve those routes
and configure CORS and trusted origins explicitly.

## Storage

The default `local-fs` storage is persisted in the `coji-storage-prod` volume.
For more than one API instance or durable cloud deployments, use
`STORAGE_PROVIDER=s3` and configure S3, R2, or MinIO variables. Media played by
the editor is still served through the signed same-origin `/files` route.

## Production checklist

- Keep `AUTH_TEST_HEADER=false` and `NODE_ENV=production`.
- Use unique database, auth, Stripe, webhook, provider, and storage secrets.
- Set `RUNNER_ENABLED=true` so provider jobs progress.
- Seed `stage_prices` with production pricing; never run `db:seed:dev`.
- Put rate limits and request-size limits at the edge.
- Restrict database and object-storage access to the application network.
- Back up PostgreSQL and durable media, and test restoration.
- Enable GitHub secret scanning and private vulnerability reporting.
- Review [`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md) and provider
  terms before commercial use.

Deployment files should be validated with `docker compose ... config` and a
real smoke test in the target environment before relying on them.
