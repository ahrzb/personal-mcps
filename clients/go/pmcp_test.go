package pmcp

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/google/jsonschema-go/jsonschema"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestConnectAddress(t *testing.T) {
	t.Parallel()

	for _, test := range []struct {
		origin string
		want   string
	}{
		{"https://hub.example", "wss://hub.example/connect"},
		{"http://localhost:8787/", "ws://localhost:8787/connect"},
	} {
		got, err := ConnectAddress(test.origin)
		if err != nil || got != test.want {
			t.Fatalf("ConnectAddress(%q) = %q, %v; want %q", test.origin, got, err, test.want)
		}
	}
	if _, err := ConnectAddress("https://hub.example/path"); err == nil {
		t.Fatal("ConnectAddress accepted an origin with a path")
	}
}

func TestBackoffDelay(t *testing.T) {
	t.Parallel()

	for _, test := range []struct {
		attempt int
		want    time.Duration
	}{
		{0, 500 * time.Millisecond},
		{3, 4 * time.Second},
		{6, 30 * time.Second},
		{20, 30 * time.Second},
	} {
		if got := BackoffDelay(test.attempt, func() float64 { return 0.5 }); got != test.want {
			t.Fatalf("BackoffDelay(%d) = %s; want %s", test.attempt, got, test.want)
		}
	}
}

func TestCallerAndSensitive(t *testing.T) {
	t.Parallel()

	who := Caller(map[string]any{
		"hub/principal": "agent:claude",
		"hub/roles":     []any{"reader", 42, "all"},
	})
	if who.Principal != "agent:claude" || !who.HasRole("admin") {
		t.Fatalf("Caller returned %#v", who)
	}

	schema := &jsonschema.Schema{
		Type: "object",
		Properties: map[string]*jsonschema.Schema{
			"credentials": {
				Type: "object",
				Properties: map[string]*jsonschema.Schema{
					"token": {Type: "string"},
				},
			},
		},
	}
	marked, err := Sensitive(schema, "credentials.token")
	if err != nil {
		t.Fatal(err)
	}
	if !marked.Properties["credentials"].Properties["token"].WriteOnly {
		t.Fatal("Sensitive did not mark the requested property")
	}
	if schema.Properties["credentials"].Properties["token"].WriteOnly {
		t.Fatal("Sensitive mutated the input schema")
	}
	if _, err := Sensitive(schema, "credentials.missing"); err == nil {
		t.Fatal("Sensitive accepted a missing property")
	}
	secret, err := Secret(schema.Properties["credentials"].Properties["token"])
	if err != nil || !secret.WriteOnly {
		t.Fatalf("Secret returned %#v, %v", secret, err)
	}
	if schema.Properties["credentials"].Properties["token"].WriteOnly {
		t.Fatal("Secret mutated the input schema")
	}
}

func TestContractFixtures(t *testing.T) {
	t.Parallel()

	data, err := os.ReadFile(filepath.Join("..", "..", "contracts", "tunnel-frames.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		ProtocolVersion string            `json:"protocolVersion"`
		Methods         map[string]string `json:"methods"`
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.ProtocolVersion != ProtocolVersion || fixture.Methods["register"] != registerMethod || fixture.Methods["replaced"] != replacedMethod {
		t.Fatalf("Go tunnel constants drifted from fixture: %#v", fixture)
	}

	data, err = os.ReadFile(filepath.Join("..", "..", "contracts", "close-codes.json"))
	if err != nil {
		t.Fatal(err)
	}
	var closeFixture struct {
		Entries map[string]struct {
			Kind     string `json:"kind"`
			Code     int    `json:"code"`
			Behavior string `json:"behavior"`
			Schedule string `json:"schedule"`
		} `json:"entries"`
	}
	if err := json.Unmarshal(data, &closeFixture); err != nil {
		t.Fatal(err)
	}
	for name, row := range closeFixture.Entries {
		var got ending
		if row.Kind == "upgrade" {
			got = endingForUpgrade(row.Code)
		} else {
			got = endingForClose(websocket.CloseError{Code: websocket.StatusCode(row.Code)})
		}
		if behaviorName(got.behavior) != row.Behavior || string(got.schedule) != row.Schedule {
			t.Errorf("%s = (%s, %s); want (%s, %s)", name, behaviorName(got.behavior), got.schedule, row.Behavior, row.Schedule)
		}
	}
}

func TestServeBridgesOfficialSDK(t *testing.T) {
	requestHandled := make(chan CallerIdentity, 1)
	subscriptionHandled := make(chan string, 1)
	hubDone := make(chan error, 1)

	hub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/connect" {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("Authorization") != "Bearer pmcp_app_test" {
			hubDone <- errors.New("missing app bearer token")
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		ws, err := websocket.Accept(w, r, nil)
		if err != nil {
			hubDone <- err
			return
		}
		defer ws.CloseNow()

		ctx := r.Context()
		var register map[string]any
		if err := readJSON(ctx, ws, &register); err != nil {
			hubDone <- err
			return
		}
		params, _ := register["params"].(map[string]any)
		if register["method"] != registerMethod || params["protocolVersion"] != ProtocolVersion {
			hubDone <- errors.New("invalid hub/register request")
			return
		}
		if err := writeJSON(ctx, ws, map[string]any{"jsonrpc": "2.0", "id": registerID, "result": map[string]any{"ok": true}}); err != nil {
			hubDone <- err
			return
		}

		meta := map[string]any{
			"io.modelcontextprotocol/protocolVersion":    ProtocolVersion,
			"io.modelcontextprotocol/clientCapabilities": map[string]any{},
		}
		if err := writeJSON(ctx, ws, rpcCall("discover", "server/discover", map[string]any{"_meta": meta})); err != nil {
			hubDone <- err
			return
		}
		var discover map[string]any
		if err := readJSON(ctx, ws, &discover); err != nil {
			hubDone <- err
			return
		}
		if discover["error"] != nil {
			hubDone <- errors.New("server/discover failed")
			return
		}

		callMeta := map[string]any{
			"io.modelcontextprotocol/protocolVersion":    ProtocolVersion,
			"io.modelcontextprotocol/clientCapabilities": map[string]any{},
			"hub/principal": "agent:claude",
			"hub/roles":     []any{"reader"},
		}
		if err := writeJSON(ctx, ws, rpcCall("call", "tools/call", map[string]any{
			"_meta": callMeta, "name": "greet", "arguments": map[string]any{"name": "Go"},
		})); err != nil {
			hubDone <- err
			return
		}
		var call map[string]any
		if err := readJSON(ctx, ws, &call); err != nil {
			hubDone <- err
			return
		}
		if call["error"] != nil {
			hubDone <- errors.New("tools/call failed")
			return
		}

		if err := writeJSON(ctx, ws, rpcCall("subscribe", "resources/subscribe", map[string]any{
			"_meta": callMeta, "uri": "news://today",
		})); err != nil {
			hubDone <- err
			return
		}
		var subscribe map[string]any
		if err := readJSON(ctx, ws, &subscribe); err != nil {
			hubDone <- err
			return
		}
		if subscribe["error"] != nil {
			hubDone <- errors.New("resources/subscribe failed")
			return
		}

		hubDone <- ws.Close(websocket.StatusCode(4000), "replaced")
	}))
	defer hub.Close()

	type greetInput struct {
		Name string `json:"name"`
	}
	type greetOutput struct {
		Greeting string `json:"greeting"`
	}
	server := mcp.NewServer(&mcp.Implementation{Name: "test", Version: "v1"}, &mcp.ServerOptions{
		Capabilities: &mcp.ServerCapabilities{},
		SubscribeHandler: func(_ context.Context, req *mcp.SubscribeRequest) error {
			subscriptionHandled <- req.Params.URI
			return nil
		},
		UnsubscribeHandler: func(context.Context, *mcp.UnsubscribeRequest) error { return nil },
	})
	mcp.AddTool(server, &mcp.Tool{Name: "greet", Description: "greet someone"},
		func(_ context.Context, req *mcp.CallToolRequest, input greetInput) (*mcp.CallToolResult, greetOutput, error) {
			requestHandled <- Caller(req.Params.GetMeta())
			return nil, greetOutput{Greeting: "Hello, " + input.Name}, nil
		})

	serveDone := make(chan error, 1)
	go func() {
		serveDone <- Serve(context.Background(), server, Options{
			URL:   hub.URL,
			Token: "pmcp_app_test",
			Roles: Roles{"reader": Patterns{"greet"}},
		})
	}()

	select {
	case err := <-hubDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("fake hub timed out")
	}
	select {
	case who := <-requestHandled:
		if who.Principal != "agent:claude" || !who.HasRole("reader") {
			t.Fatalf("handler received %#v", who)
		}
	default:
		t.Fatal("tool handler was not called")
	}
	select {
	case uri := <-subscriptionHandled:
		if uri != "news://today" {
			t.Fatalf("subscription URI = %q", uri)
		}
	default:
		t.Fatal("subscribe handler was not called")
	}
	select {
	case err := <-serveDone:
		if err != nil {
			t.Fatalf("Serve returned %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Serve did not stop after replacement")
	}
}

func TestTransportReconnectsAfterSocketDrop(t *testing.T) {
	previousRNG := randomFloat64
	randomFloat64 = func() float64 { return 0 }
	defer func() { randomFloat64 = previousRNG }()

	var connections atomic.Int32
	hubDone := make(chan error, 1)
	hub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := websocket.Accept(w, r, nil)
		if err != nil {
			hubDone <- err
			return
		}
		defer ws.CloseNow()
		ctx := r.Context()
		var register map[string]any
		if err := readJSON(ctx, ws, &register); err != nil {
			hubDone <- err
			return
		}
		if err := writeJSON(ctx, ws, map[string]any{"jsonrpc": "2.0", "id": registerID, "result": map[string]any{"ok": true}}); err != nil {
			hubDone <- err
			return
		}
		if connections.Add(1) == 1 {
			_ = ws.Close(websocket.StatusServiceRestart, "deploy")
			return
		}
		meta := map[string]any{
			"io.modelcontextprotocol/protocolVersion":    ProtocolVersion,
			"io.modelcontextprotocol/clientCapabilities": map[string]any{},
		}
		if err := writeJSON(ctx, ws, rpcCall("discover", "server/discover", map[string]any{"_meta": meta})); err != nil {
			hubDone <- err
			return
		}
		var discover map[string]any
		if err := readJSON(ctx, ws, &discover); err != nil {
			hubDone <- err
			return
		}
		if discover["error"] != nil {
			hubDone <- errors.New("server/discover failed after reconnect")
			return
		}
		hubDone <- ws.Close(websocket.StatusCode(4000), "replaced")
	}))
	defer hub.Close()

	server := mcp.NewServer(&mcp.Implementation{Name: "reconnect-test", Version: "v1"}, &mcp.ServerOptions{
		Capabilities: &mcp.ServerCapabilities{},
	})
	serveDone := make(chan error, 1)
	go func() {
		serveDone <- Serve(context.Background(), server, Options{URL: hub.URL, Token: "pmcp_app_test"})
	}()
	select {
	case err := <-hubDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("reconnect timed out")
	}
	select {
	case err := <-serveDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Serve did not stop after the reconnected socket was replaced")
	}
	if got := connections.Load(); got != 2 {
		t.Fatalf("connections = %d; want 2", got)
	}
}

func TestTerminalHandshakeErrors(t *testing.T) {
	t.Run("credential", func(t *testing.T) {
		hub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
		}))
		defer hub.Close()
		transport, err := NewHubTransport(Options{URL: hub.URL, Token: "bad"})
		if err != nil {
			t.Fatal(err)
		}
		_, err = transport.Connect(context.Background())
		var credentials *CredentialsError
		if !errors.As(err, &credentials) || credentials.Status != http.StatusUnauthorized {
			t.Fatalf("Connect error = %v; want CredentialsError(401)", err)
		}
	})

	t.Run("registration", func(t *testing.T) {
		hub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ws, err := websocket.Accept(w, r, nil)
			if err != nil {
				return
			}
			defer ws.CloseNow()
			var register map[string]any
			if readJSON(r.Context(), ws, &register) != nil {
				return
			}
			_ = writeJSON(r.Context(), ws, map[string]any{
				"jsonrpc": "2.0",
				"id":      registerID,
				"error":   map[string]any{"code": -32602, "message": "bad roles"},
			})
		}))
		defer hub.Close()
		transport, err := NewHubTransport(Options{URL: hub.URL, Token: "pmcp_app_test"})
		if err != nil {
			t.Fatal(err)
		}
		_, err = transport.Connect(context.Background())
		var registration *RegistrationError
		if !errors.As(err, &registration) || registration.Message != "bad roles" {
			t.Fatalf("Connect error = %v; want RegistrationError", err)
		}
	})
}

func behaviorName(value behavior) string {
	switch value {
	case stopFatal:
		return "stop_fatal"
	case stopQuiet:
		return "stop_quiet"
	default:
		return "reconnect"
	}
}

func rpcCall(id, method string, params any) map[string]any {
	return map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params}
}

func readJSON(ctx context.Context, ws *websocket.Conn, target any) error {
	kind, data, err := ws.Read(ctx)
	if err != nil {
		return err
	}
	if kind != websocket.MessageText {
		return errors.New("expected a text WebSocket frame")
	}
	return json.Unmarshal(data, target)
}

func writeJSON(ctx context.Context, ws *websocket.Conn, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return ws.Write(ctx, websocket.MessageText, data)
}
