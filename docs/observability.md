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

Non-empty trace-specific standard variables take precedence over their generic
counterparts; an empty trace-specific value is treated as unset:

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
the worker sets both `service.name` and `openinference.project.name` to the fixed
application identity `greeks-in-the-loop`.

### Arize AX managed tracing

Use the OTLP HTTP/protobuf endpoint for the AX region that stores the traces:

| Region | Trace endpoint |
| --- | --- |
| US | `https://otlp.arize.com/v1/traces` |
| EU | `https://otlp.eu-west-1a.arize.com/v1/traces` |
| CA | `https://otlp.ca-central-1a.arize.com/v1/traces` |

AX's HTTP exporter accepts the API key through `authorization` and the Space ID
through `arize-space-id`. Configure them through the existing OTel header
setting; this application does not read `ARIZE_*` convenience variables or use
an Arize-specific SDK:

```bash
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://otlp.arize.com/v1/traces
OTEL_EXPORTER_OTLP_TRACES_HEADERS=authorization=YOUR_API_KEY,arize-space-id=YOUR_SPACE_ID
```

After saving the settings in `.env`, run `pnpm agent:once` and confirm that the
`research.cycle` trace appears under `greeks-in-the-loop` without prompt,
response, or tool content. See the official
[AX manual instrumentation](https://arize.com/docs/ax/instrument/manual-instrumentation)
guide for current endpoints and authentication requirements. Monitor ingestion
and retention against the selected AX plan before deciding whether sampling is
needed.

## What is emitted

Each attempt creates a root `research.cycle` AGENT span. Eligible cycles add
coarse child spans for eligibility, the OpenCode prompt operation, report
parsing, decision validation, quote confirmation, intent derivation, ledger
terminalization, and artifact projection when those operations run.

The allowlisted attributes are limited to attempt/cycle/session identifiers,
agent, prompt, skill, strategy, and contract versions, bounded outcome or skip
reason, provider/model identifiers, token counts, and bounded tool metadata.
Prompt and skill versions are checked-in constants and must be incremented when
their behavior changes so AX experiments can group comparable runs.

After `session.prompt` completes, the worker reduces its typed assistant message
and finalized tool parts to a content-free summary. The prompt span records
OpenInference input, output, reasoning, and cache token counts plus aggregate
tool completion/error counts and a content-free assistant-error flag. Up to 32
fixed-name `opencode.tool` child spans record validated timing, an allowlisted
tool name, and `completed`, `error`, or `incomplete` status. Configured Alpaca,
FMP, Exa, `trusted_time`, `read`, and `skill` names are retained; every unknown
name becomes `other`.

Tracing deliberately excludes:

- prompts, model responses, reports, decisions, evidence, quotes, and artifacts;
- exception messages and stack traces;
- provider URLs, request/response bodies, headers, and credentials;
- token content, tool arguments/results, filesystem paths, HTTP payloads, and
  automatic SDK instrumentation.

Variables prefixed by `OTEL_`, `ARIZE_`, or `PHOENIX_` are removed from the
managed OpenCode child environment, where
`OTEL_SDK_DISABLED=true` is then forced to prevent preloaded or transitive
instrumentation from tracing agent content. SQLite remains the authoritative
research record; trace identifiers are not written into the ledger in this
phase.

The worker deliberately uses the finalized `session.prompt` response instead of
opening the SDK's live SSE event stream. The response exposes the same completed
assistant and tool records needed for comparison without adding stream retries,
cross-session routing, or another shutdown path. SQLite remains authoritative;
these operational measurements are not written into research artifacts.

Deterministic offline run evaluation is documented in
[Offline research evaluation](research-evaluation.md). LLM judging, evaluation
datasets, and AX evaluation publication remain separate increments.
