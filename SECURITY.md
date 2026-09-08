# Security

## Intended deployment

Roadtrip is an early-release application for a trusted household on a private network. Use trusted HTTPS, read-only source mounts and a private data volume. The shared password is not separate user authorization or parental controls.

Demo mode disables login. Do not expose it to a network. The included demo publishes only on loopback; production's optional HTTPS proxy serves the household address.

## Sensitive data

Do not publish `.env`, tokens, cookies, session keys, catalogs, inventories, cache/data backups, or private certificate keys. These can disclose server paths and viewing choices. Runtime files are excluded from the source repository.

Rotate the relevant Plex token/password and recreate the application after a leak. Changing the family password invalidates earlier session signatures. Sign-out clears the current browser cookie; it does not revoke a copied cookie elsewhere.

## Reporting vulnerabilities

Do not post exploit details or secrets in a public issue. If GitHub's **Report a vulnerability** option is available under Security, use it. Otherwise open a minimal issue asking the maintainer for a private channel, without technical details or sensitive data.

In the private report include version, a synthetic reproduction, expected/actual behavior and impact. No response-time guarantee is implied.

The latest published release is the maintenance target. This project has not had an independent security audit. See [validation](VALIDATION.md) for checks and limits.
