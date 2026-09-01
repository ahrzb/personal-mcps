# personal-mcp-client

Keep an MCP server reachable through a [personal-mcps](https://github.com/ahrzb/personal-mcps) hub's reverse tunnel: dial the hub over WebSocket, register the service, and bridge frames into the official MCP Python SDK, reconnecting as needed.

```python
from pmcp_client import serve

await serve(mcp, url="https://mcp.example.com", token="pmcp_svc_...")
```

The JavaScript sibling is [`@ahrzb/personal-mcp-client`](https://www.npmjs.com/package/@ahrzb/personal-mcp-client); the hub and full docs live in the repo above.
