# Research tracing

Research tracing is optional and vendor-neutral. The worker emits a small set of
manual OpenTelemetry spans using OpenInference span kinds and exports them in
OTLP HTTP/protobuf format. It does not use an Arize-specific runtime wrapper.

Tracing is disabled by default. Set either endpoint to enable it:

```bash
# Base endpoint: the worker appends /v1/traces.
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:6006

# Or an exact trace endpoint (takes precedence).
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:6006/v1/traces
```

The trace-specific standard variables take precedence over their generic
counterparts:

| Trace-specific | Generic | Purpose |
| --- | --- | --- |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | `OTEL_EXPORTER_OTLP_ENDPOINT` | HTTP/protobuf collector URL |
| `OTEL_EXPORTER_OTLP_TRACES_HEADERS` | `OTEL_EXPORTER_OTLP_HEADERS` | Comma-separated, percent-encoded `name=value` headers |
| `OTEL_EXPORTER_OTLP_TRACES_TIMEOUT` | `OTEL_EXPORTER_OTLP_TIMEOUT` | Export timeout in milliseconds |

The timeout defaults to 2 seconds and is capped at 5 seconds. Set
`OTEL_SDK_DISABLED=true` to force tracing off. Invalid configuration, exporter
startup failure, and flush failure produce a generic warning and never stop a
research cycle. Export is batched, and shutdown is bounded and idempotent.

## Backends

For local Phoenix, point the generic endpoint at `http://localhost:6006`. The
worker appends the documented HTTP collector path. A project can be selected
with a header:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:6006
OTEL_EXPORTER_OTLP_HEADERS=x-project-name=greeks-in-the-loop
```

Phoenix Cloud and authenticated self-hosted Phoenix accept an exact endpoint
and bearer authorization header. Header values use the standard OTel
percent-encoded form:

```bash
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://app.phoenix.arize.com/v1/traces
OTEL_EXPORTER_OTLP_TRACES_HEADERS=authorization=Bearer%20YOUR_API_KEY,x-project-name=greeks-in-the-loop
```

See the official [Phoenix endpoint](https://arize.com/docs/phoenix/learn/faqs/what-is-my-phoenix-endpoint),
[authentication](https://arize.com/docs/phoenix/deployment/authentication), and
[project routing](https://arize.com/docs/phoenix/tracing/how-to-tracing/setup-tracing/setup-projects)
documentation. Arize AX can use the same OpenTelemetry/OpenInference spans;
copy the regional endpoint and authentication headers from the official
[AX tracing setup](https://arize.com/docs/ax/instrument/set-up-tracing). Confirm
that the selected AX endpoint accepts OTLP HTTP/protobuf rather than configuring
the gRPC exporter examples, because this worker intentionally supports one
transport in this PR.

## What is emitted

Each attempt creates a root `research.cycle` AGENT span. Eligible cycles add
coarse child spans for eligibility, the OpenCode prompt operation, report
parsing, decision validation, quote confirmation, intent derivation, ledger
terminalization, and artifact projection when those operations run.

The allowlisted attributes are limited to attempt/cycle/session identifiers,
agent and contract versions, bounded outcome or skip reason, and provider/model
identifiers. Span status records success or failure without exception text.

Tracing deliberately excludes:

- prompts, model responses, reports, decisions, evidence, quotes, and artifacts;
- exception messages and stack traces;
- provider URLs, request/response bodies, headers, and credentials;
- token-level, tool-step, filesystem, HTTP, and automatic SDK instrumentation.

Telemetry configuration and `PHOENIX_API_KEY` are removed from the managed
OpenCode child environment. SQLite remains the authoritative research record;
trace identifiers are not written into the ledger in this phase.

Detailed OpenCode event adaptation and token/tool metadata belong to the next
tracing increment. Evaluation datasets, scorers, and prompt/skill comparisons
remain a separate evaluation increment.
