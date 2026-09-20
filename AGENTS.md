# Project operating rules

These rules apply to every future change in this repository.

1. Read `docs/README.md` and `docs/STATUS.md` before changing production behavior.
2. Update `CHANGELOG.md` for every user-visible, operational, security, data, or configuration change. Do not list purely mechanical formatting.
3. Update `docs/STATUS.md` when the current architecture, production state, known limitations, risks, or next priorities change.
4. Add an entry to `docs/DEPLOYMENTS.md` only after a real production deployment or rollback. Include the version, UTC time, source revision, result, and verification performed.
5. Add a confirmed outage, degradation, failed deployment, data problem, or monitoring failure to `docs/INCIDENTS.md`. Include impact, detection, timeline, cause, recovery, verification, and follow-up. A harmless local command typo with no production effect may be recorded as an operational event but is not a production incident.
6. Never put secrets, tokens, passwords, private server addresses, raw Telegram IDs, or user message contents in documentation, commits, logs, or task updates.
7. Use semantic versions. Patch = compatible fix, minor = compatible feature, major = incompatible behavior or data contract. Keep `package.json` and `package-lock.json` aligned.
8. Before release run `npm run check`. After release verify the server revision, Compose services, PostgreSQL health, bot restart count, and recent error logs.
9. PostgreSQL must remain bound to localhost. Do not expose it publicly for support access; use the protected `/admin` interface or an SSH session.
10. Monitoring should be quiet while healthy. Repair only safe, reversible failures automatically; never delete data, rotate secrets, change billing, or make a product decision without the owner.

