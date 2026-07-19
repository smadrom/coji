# Credits & Billing

[[Home]] · related: [[Job-Runner]] · [[Pipeline]] · [[Providers]]

Internal currency = **credits**. `CREDIT_USD_RATE` (default 1 credit ≈ $1) lets pricing be re-tuned without code changes.

## `stage_prices` (retail price table)
`stage[image|animation|render]`, `unit[per_set|per_clip|per_export]` (bounded units only — the exact hold is known before a paid call), `credits`, `notes`.

> ⚠️ **Must be seeded** or paid stages 500 (`No stage_prices row...`). Live seed: image `per_set`=5, animation `per_clip`=5 (×N clips composed — formerly ×4 fixed), render `per_export`=10. See [[Runbook]].

**Clip-composer pricing:** animation cost = `per_clip × N` where N is the number of clips the user authored in the composer step. The CTA shows the live cost before the user commits. N is bounded by `MAX_CLIPS_PER_PROJECT` (20). Each clip's hold is keyed by `${clipId}:${attempt}` — so holds are placed and settled per clip independently (partial failure refunds only the failed clips' holds, not the whole batch).

## `credit_ledger` (append-only)
`user_id, project_id, stage, kind[hold|debit|refund|topup], credits, balance_after, provider_job_id, payment_ref`.
User **balance = latest `balance_after`**. Unique `(provider_job_id, kind)` and `payment_ref` indexes make settlement idempotent.

## Hold → debit / refund (one writer)
1. Pre-flight: balance ≥ stage price?  (else `402`)
2. **hold** placed before the paid call.
3. On success → **debit** (hold consumed); `projects.credits_spent` rolled up in the same txn.
4. On failure → **refund**.

All settlement happens inside [[Job-Runner|applyJobResult]] and is idempotent under retries/partial failure.

## Payments (`PAYMENTS_PROVIDER`) — top-up
`modules/billing`: `POST /billing/checkout` (auth → checkout session for a credit pack), `POST /webhooks/stripe` (raw body, signature verify → idempotent `topupForPayment` keyed on `payment_ref`), `GET /billing/balance` (balance + pack catalog: starter/pro/studio).

| value | notes |
|---|---|
| `noop` (default) | deterministic; **barred in prod at boot** (`NODE_ENV=production` → throws). The live test deploy runs `NODE_ENV=development` for this reason — see [[Gotchas]]. |
| `stripe` | real, pinned `Stripe-Version`; needs `STRIPE_API_KEY`. |

## Grant credits manually (dev)
No admin endpoint yet — insert a ledger row:
```sql
INSERT INTO credit_ledger (user_id, stage, kind, credits, balance_after)
VALUES ('<user_id>', 'topup', 'topup', 100, 100);
```
