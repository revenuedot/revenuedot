# Test fixtures (test only)

These keys and certificates exist only for the single sign-on tests in `ee/test/`. They are not secrets and protect
nothing: never use them anywhere else.

- `idp-key.pem`, `idp-cert.pem`: the test identity provider that signs SAML assertions (`ee/test/saml-idp.ts`).
- `attacker-key.pem`, `attacker-cert.pem`: a second identity provider the server does not trust, for the forged
  signature tests.

Made with `openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=..."`.
