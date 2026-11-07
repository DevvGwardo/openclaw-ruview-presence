# Security Policy

## Supported versions

Only the latest `main` branch receives security fixes.

## Reporting a vulnerability

Please report privately:

1. Open a GitHub Security Advisory on this repository
   (Report a vulnerability → Security tab), or
2. Email the repository owner via the contact in the GitHub profile.

Please do **not** open a public issue for anything security-sensitive.
Include reproduction steps and affected code paths where possible; you'll get
an acknowledgement within a few days.

## Scope notes

- This plugin talks to a local RuView presence service
  (`ruviewUrl`, default `http://localhost:3001`). The optional API key is
  held in the host process memory only and never logged.
- No telemetry, no outbound connections other than the configured RuView
  endpoint.
