# ns-dsh-llm-devin

DeepSeek Harness (dsh) LLM adapter that adds Devin (Cognition Cascade) as a
model provider. Sessions come from the machine — `devin auth login` — so no
credential setup lives here.

```yaml
- id: llm-devin
  name: 'dsh-llm-devin'
  config:
    provider: devin
```

Streams text, reasoning, and tool calls through `ns-devin-core` and maps
Devin's failures onto the Harness `LlmError` routing codes. Works with dsh
0.2 (tool-role messages) and still reads the dsh 0.1 `tool-result` blocks.
