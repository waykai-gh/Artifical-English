# Changelog

All meaningful changes to the bot are recorded here. Versions follow semantic versioning.

## Unreleased

- No changes yet.

## 1.1.1 — 2026-09-22

### Security and reliability

- Preserve pseudonymous daily request counters across `/forget` and re-consent; migrate existing counters without resetting quota. Add atomic global daily/minute caps and bounded update concurrency.
- Audit support reads before accessing user data; deny reads if audit storage fails. Exclude expired conversation content from admin history even when cleanup fails. Update consent and deletion notices.
- Remove the fallback PostgreSQL password and full `.env` injection. Generate an application-only raw runtime file, a separate database secret and a persistent HMAC key; reject weak/missing database passwords and accidental HMAC changes.
- Pin Node/PostgreSQL images by digest; run the bot without writable root, additional capabilities or privilege escalation, with bounded temporary storage and processes.
- Add polling/database health probes, readiness-aware external heartbeat, STT/TTS failure reporting and hourly-maintenance incident tracking. Failed alert delivery no longer suppresses immediate retry.
- Add encrypted backup, isolated restore checks, backup freshness monitoring and a host watchdog that restarts only an unhealthy bot, with a 15-minute cooldown.
- Add GitHub release checks for TypeScript/build/tests, real PostgreSQL concurrency/locks, dependency and Git secret scans, rendered Compose configuration, and local voice under container restrictions.

### Remaining operational choices

- Independent external dead-man monitoring and an automated off-server backup destination still require owner setup. Snapshot retention and deletion propagation after disaster recovery must be settled before a broad public launch.

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
