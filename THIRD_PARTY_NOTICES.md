# Third-party notices

The MIT License in this repository covers coji's own source code. Dependencies,
hosted APIs, generated assets, models, and provider content remain subject to
their own licenses and terms.

## Remotion

Coji uses Remotion 4.x packages for browser preview and an isolated local-render
spike. Remotion is distributed under its own license, not MIT. At version
4.0.491, individuals, non-profit organizations, and for-profit organizations
with up to three employees are eligible for the free license; other commercial
organizations must obtain a Company License. Review the exact license shipped
with the installed Remotion packages and the
[Remotion license page](https://www.remotion.dev/docs/license) before use.

The primary production export path uses ffmpeg to trim and concatenate existing
clips, while the web editor still uses `@remotion/player`.

## External providers

Gemini, OpenRouter, HeyGen, Stripe, AWS S3-compatible services, and any models
selected through them have separate service terms, acceptable-use rules,
pricing, and output-rights policies. Enabling an integration is the deployer's
responsibility and may incur charges.

Run `bunx license-checker --production --summary` in each workspace when
updating dependencies, and inspect any package reported with a custom or missing
license.
