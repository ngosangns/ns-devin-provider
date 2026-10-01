# ns-dsh-llm-devin

DeepSeek Harness (dsh) LLM adapter that adds Devin (Cognition Cascade) as a
model provider. Sessions come from the machine — `devin auth login` — so no
credential setup lives here.

Grok models from the same catalog are registered on a separate `grok` route
so the model picker does not file them under Devin. Set `grokProvider: ""` to
keep one combined list.

```yaml
- id: llm-devin
  name: 'dsh-llm-devin'
  config:
    provider: devin
```

Streams text, reasoning, and tool calls through `ns-devin-core` and maps
Devin's failures onto the Harness `LlmError` routing codes.
