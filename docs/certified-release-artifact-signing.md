# Koa's Events: cryptographically signed production-release exports

## Security model

The protected System Health export endpoint issues **three separate files** for
one fully certified, exact current production release:

1. `?export=certified-release&format=pdf` — immutable PDF bytes.
2. `?export=certified-release&format=json` — immutable JSON bytes.
3. `?export=certified-release&format=signature` — detached `.sig.json` manifest.

The manifest uses **Ed25519** over domain-separated exact PDF bytes, exact JSON
bytes, and the manifest's release metadata. It includes SHA-256 hashes, byte
sizes, commit SHA, published Netlify deploy ID, GitHub Actions run ID, and the
signer's public-key fingerprint. The server never exposes the private key.

This is **detached cryptographic artifact signing**, **not** a PDF PAdES/CMS
signature embedded in the PDF's signature field. A PDF viewer might not show
the document as natively digitally signed. The detached manifest verifies it.

## Setup and key custody

Generate an Ed25519 key pair in a trusted offline/key-management environment:

```sh
openssl genpkey -algorithm ED25519 -out koa-release-ed25519-private.pem
openssl pkey -in koa-release-ed25519-private.pem -pubout -out koa-release-ed25519-public.pem
```

Never commit, email, log, or attach the private key. Store it in a managed secret
vault with restricted access, backup/rotation policy, and audit logging. Store
the **PEM contents** in Netlify Koas Admin project `koasevents-website` as a
**secret** environment variable:

- Name: `KOA_CERTIFICATION_SIGNING_PRIVATE_KEY_PEM`
- Scope: **Functions**
- Context: **production**

Deploy only after the key is installed. Never use a test key in production;
rotate by issuing a new public key fingerprint and retaining older public
keys for historical verification. If the key is absent or invalid, all three
export formats fail closed with no certificate.

Publish the corresponding Ed25519 public key and its SHA-256 SPKI fingerprint
in a separately trusted location controlled by the organization. Do not trust
only the public key embedded in the downloaded manifest: an attacker who can
replace the manifest can replace that key. Independent verifiers must pin the
known public key.

## Independent verification

Download PDF, JSON, and `.sig.json` for the same release. On a trusted system:

```sh
node scripts/verify_signed_certified_release_bundle.mjs \
  --pdf koa-certified-release-DEPLOY.pdf \
  --json koa-certified-release-DEPLOY.json \
  --signature koa-certified-release-DEPLOY.sig.json \
  --public-key koa-release-ed25519-public.pem
```

The verifier requires the pinned external public key, validates the manifest
signature and the **exact** PDF and JSON bytes, and verifies the commit, deploy,
and run identity inside the signed JSON. It fails on any changed byte, swapped
public key, or mismatch.

A valid signature means the release was attested **at issuance time**. It does
**not** mean the same commit is still live forever. To claim "current
production," independently compare today's GitHub `main` SHA with the
currently published, ready Netlify production deploy's exact ID and commit.
The export endpoint does this twice during each export and refuses an older
certified release when new production is unpublished or uncertified.

## Fail-closed conditions

The endpoint rejects unauthorized users (403), missing or stale current
release evidence (409), missing signing key or unavailable upstream identity
verification (503), and unsupported formats (400). Only a successful signed
Release History, zero-failure Chromium/WebKit QA, certified PDF/JSON byte
proof, and the currently serving exact production deployment are exportable.
No customer data or private screenshot pixels are included.
