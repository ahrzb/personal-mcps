# personal-mcps Go client

Keep an MCP server reachable through a [personal-mcps](https://github.com/ahrzb/personal-mcps) hub's reverse tunnel. The package uses the official [`modelcontextprotocol/go-sdk`](https://github.com/modelcontextprotocol/go-sdk), registers the app, and reconnects transparently.

```go
server := mcp.NewServer(&mcp.Implementation{Name: "mybot", Version: "v1"}, nil)

err := pmcp.Serve(context.Background(), server, pmcp.Options{
    Roles: pmcp.Roles{"reader": pmcp.Patterns{"get_*"}},
})
```

`Options.URL` and `Options.Token` default to `PMCP_URL` and `PMCP_APP_TOKEN`. See the repository's [client quickstart](../../docs/quickstart-clients.md) for a complete example.
