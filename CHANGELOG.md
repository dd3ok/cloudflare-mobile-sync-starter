# Changelog

## 0.1.0 - 2026-07-23

First public source pre-release.

- Self-hosted Cloudflare Worker and D1 authentication/sync backend
- Platform-neutral API contract and client core
- Expo SDK 57 authentication and SecureStore adapter
- Google, Kakao, and Naver server adapters
- Idempotent incremental sync, tombstones, conflict handling, and account deletion
- English and Korean setup, operations, security, and self-hosting guides
- Two isolated maintainer consumer integrations across Expo and a non-Expo client

Known limits: workspace packages are not published to npm, the maintainer
deployments are not public sandboxes, iOS real-device verification remains, and
Kakao/Naver do not yet have production credentials or real-account verification.
