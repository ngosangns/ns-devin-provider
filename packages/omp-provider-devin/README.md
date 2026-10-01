# ns-omp-provider-devin

OMP (oh-my-pi) provider plugin: adds Devin (Cognition Cascade) models.

```bash
omp install npm:ns-omp-provider-devin
# or
pi install npm:ns-omp-provider-devin
```

- `/login devin` — reuses the Devin CLI session
  (`~/.local/share/devin/credentials.toml`), runs the browser PKCE flow when
  none exists, and accepts a `cog_…` API key as a fallback. A successful login
  is written back to the shared credential file.
- Models come from Devin's `GetCliModelConfigs` discovery (cached ~24h), with
  the `swe-1-6` family as the unauthenticated bootstrap.
- Account usage (credits, daily/weekly quota) shows in OMP's usage panel.
