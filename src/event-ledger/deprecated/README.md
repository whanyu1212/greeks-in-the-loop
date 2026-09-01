# Deprecated SQLite Adapter

These modules support local development and isolated tests only. Production
deployments use PostgreSQL, lazy-load no SQLite code, and omit this directory
and `better-sqlite3` from the runtime image.
