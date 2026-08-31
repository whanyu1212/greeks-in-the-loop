# Observability

Terminal stage reporting is always available. OpenTelemetry export is optional and enabled only when an OTLP endpoint is configured.

Traces retain bounded cycle, agent, prompt, contract, model, aggregate token, complete-session tool-count, duration, schema-repair, and outcome metadata. They do not retain prompt text, model responses, research prose, URLs, symbols, provider payloads, or credentials.

One schema-only correction turn is allowed after an invalid model response. The correction receives only bounded issue codes, categories, and paths; raw rejected content is not written to traces or the ledger.

The cycle mode is `STANDARD` or `DRY_RUN`. Skill and strategy-registry attributes no longer exist.

See `.env.example` for OTLP settings.
