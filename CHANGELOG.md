# Changelog

All meaningful changes to the bot are recorded here. Versions follow semantic versioning.

## Unreleased

- No changes yet.

## 1.1.0 — 2026-09-20

### Added

- Explicit consent before collecting data, a short privacy explanation, `/forget`, and disclosure that the product was created with AI.
- Private `/admin` statistics, AI usage monitoring, anomaly alerts, provider budget warnings, and support views for individual users.
- A0 onboarding and an interim simplified A1 response mode.
- Local interception of explicit prompt-override attempts and output filtering for code/HTML role drift.
- Internal operations, deployment, incident, and current-status documentation.
- A scheduled Codex production check that stays quiet while the service is healthy and can perform limited safe recovery.

### Changed

- The main menu was reduced and learning guidance moved into the information section.
- Existing users must accept consent version `2026-09-20.2`; completed onboarding and the selected level are preserved.
- PostgreSQL support access remains private through SSH and the owner-only bot interface.

### Known limitations

- A1 is a response-simplicity guard, not a complete CEFR curriculum. A full level-based learning program is still required.
- A locally scheduled Codex check requires the workstation running Codex to stay online. Docker restart policies and Telegram alerts continue independently on the server.

## 1.0.0 — 2026-09-12

- Initial production release of the Telegram English tutor with PostgreSQL history, personal vocabulary, voice input/output, AI-provider fallback, Docker deployment, resource limits, and log rotation.

