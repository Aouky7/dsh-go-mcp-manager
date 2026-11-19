# Third-party dependencies

This repository distributes the plugin source. It does not vendor the dsh-go app, the DSH engine, or dependency source trees. Package installation obtains dependencies separately; their license and copyright notices remain authoritative.

Direct runtime dependencies and host peers:

- `@modelcontextprotocol/client` — 2.3.0 — MIT — official MCP TypeScript client SDK.
- `@deepseek-ai/cordis` — 4.1.x — MIT — host plugin lifecycle.
- `@deepseek-ai/schemastery` — 3.19.x — MIT — host configuration schema.
- `@deepseek-ai/dsh-mcp-client` — 0.2.2-rc.1 — MIT — MCP tool-definition integration.
- `@deepseek-ai/dsh-credentials` — 0.2.2-rc.1 — MIT — host credential references and storage integration.
- `@deepseek-ai/dsh-subprocess` — 0.2.2-rc.1 — MIT — host subprocess environment filtering.

All transitive package versions are listed in `package-lock.json`. This project uses standard MCP and DSH APIs; it does not claim authorship of the protocol, SDKs, host, or the general concept of an MCP manager.

Native validation tests require the separately provided dsh-go-plugin development kit. The kit is not bundled in this repository. No substitute validator is used when the kit is absent; `test:native` reports the missing requirement, while `test:core` can run independently.

`package.json` overrides select compatible fixes for Zod and Undici, and align the nested MCP client SDK version. These apply to this package's dependency installation, not an audit or modification of every dependency in a running DSH host.
