# Security policy

## Supported versions

Security fixes are applied to the current `main` branch and, after public
releases begin, the latest published release. Older development snapshots are
not supported.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private
security advisory form:

<https://github.com/smadrom/coji/security/advisories/new>

Include the affected commit or version, impact, reproduction steps, and a
minimal proof of concept when possible. Remove real credentials, personal data,
and customer media from the report.

Maintainers will acknowledge the report, investigate it, coordinate a fix, and
credit the reporter if requested and appropriate. Please allow time for a fix
before public disclosure.

If a real secret was committed or exposed, revoke or rotate it immediately.
Removing it from the latest commit is not sufficient because Git history and
forks may still contain the value.

## Deployment responsibility

Self-hosters are responsible for authentication secrets, provider keys,
database access, object-storage policy, TLS, backups, rate limits, and provider
terms. Keep `AUTH_TEST_HEADER=false` in production and never place secrets in a
`VITE_*` variable.
