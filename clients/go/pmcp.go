// Package pmcp keeps an MCP server reachable through a personal-mcps hub.
package pmcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
	"net/url"
	"os"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/google/jsonschema-go/jsonschema"
	"github.com/modelcontextprotocol/go-sdk/jsonrpc"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const (
	// ProtocolVersion is the MCP revision spoken by the tunnel.
	ProtocolVersion = "2026-07-28"

	registerMethod = "hub/register"
	replacedMethod = "hub/replaced"
	registerID     = "hub-register-1"
	clientVersion  = "personal-mcps-go/0"

	backoffBase = time.Second
	backoffCap  = 60 * time.Second
	pingEvery   = 25 * time.Second
)

var (
	randomFloat64 = rand.Float64
	sleep         = sleepContext
)

// Patterns is the tools-only spelling of a role declaration.
type Patterns []string

// Families is the per-capability spelling of a role declaration.
type Families struct {
	Tools     []string `json:"tools,omitempty"`
	Prompts   []string `json:"prompts,omitempty"`
	Resources []string `json:"resources,omitempty"`
}

// Roles maps role names to either Patterns or Families. The hub validates and
// normalizes declarations; this package sends them unchanged.
type Roles map[string]any

// TypeScriptAliases carries optional hub-local TypeScript alias hints beside
// Roles in hub/register (spec §23, wire key "typescriptAliases"). Both members
// are optional; a nil pointer in Options means no hints are sent at all. An
// alias never renames the app's MCP wire surface — canonical service/tool names
// keep crossing the MCP wire untouched — and the hub, not this package, is the
// syntax and collision authority: a malformed hint is refused at registration
// (RegistrationError) while a valid hint that collides leaves the established
// assignment in place and never disconnects the tunnel.
type TypeScriptAliases struct {
	// Service is a preferred TypeScript name for the app's service namespace.
	Service string `json:"service,omitempty"`
	// Tools maps canonical MCP tool names to preferred TypeScript names.
	Tools map[string]string `json:"tools,omitempty"`
}

// Options configures Serve and NewHubTransport. URL and Token fall back to
// PMCP_URL and PMCP_APP_TOKEN in Serve.
type Options struct {
	URL   string
	Token string
	Roles Roles
	// TypeScriptAliases is optional; nil sends no alias hints.
	TypeScriptAliases *TypeScriptAliases
}

// CredentialsError means the hub rejected or revoked the app credential.
type CredentialsError struct {
	Status int
}

func (e *CredentialsError) Error() string {
	if e.Status < 1000 {
		return fmt.Sprintf("the hub refused the app credential (%d)", e.Status)
	}
	return fmt.Sprintf("the hub severed the connection (close %d)", e.Status)
}

// RegistrationError means the hub rejected the role declaration.
type RegistrationError struct {
	Message string
}

func (e *RegistrationError) Error() string { return "hub/register rejected: " + e.Message }

// Serve runs server through the hub until ctx is cancelled or the transport
// reaches a terminal state. A replacement returns nil; dead credentials and
// invalid role declarations return typed errors. Other disconnects reconnect
// forever with jittered backoff.
func Serve(ctx context.Context, server *mcp.Server, options Options) error {
	if server == nil {
		return errors.New("pmcp: nil MCP server")
	}
	if options.URL == "" {
		options.URL = os.Getenv("PMCP_URL")
	}
	if options.Token == "" {
		options.Token = os.Getenv("PMCP_APP_TOKEN")
	}
	transport, err := NewHubTransport(options)
	if err != nil {
		return err
	}
	err = server.Run(ctx, transport)
	if errors.Is(err, io.EOF) {
		return nil
	}
	return err
}

// HubTransport is an mcp.Transport backed by the hub's reverse WebSocket.
type HubTransport struct {
	address string
	token   string
	roles   Roles
	// aliases is nil when the caller declared no hints; it is re-sent verbatim
	// on every registration, never interpreted by this package.
	aliases *TypeScriptAliases
}

// NewHubTransport validates options without performing network I/O.
func NewHubTransport(options Options) (*HubTransport, error) {
	if options.URL == "" {
		return nil, errors.New("pmcp: no hub URL")
	}
	if options.Token == "" {
		return nil, errors.New("pmcp: no app token")
	}
	address, err := ConnectAddress(options.URL)
	if err != nil {
		return nil, err
	}
	if options.Roles == nil {
		options.Roles = Roles{}
	}
	return &HubTransport{
		address: address,
		token:   options.Token,
		roles:   options.Roles,
		aliases: options.TypeScriptAliases,
	}, nil
}

// SupportsProtocolVersion restricts the official MCP SDK's discover response
// to the tunnel's pinned wire revision.
func (*HubTransport) SupportsProtocolVersion(version string) bool {
	return version == ProtocolVersion
}

// Connect implements mcp.Transport.
func (t *HubTransport) Connect(ctx context.Context) (mcp.Connection, error) {
	conn := &hubConn{address: t.address, token: t.token, roles: t.roles, aliases: t.aliases}
	if err := conn.establish(ctx, ""); err != nil {
		return nil, err
	}
	return conn, nil
}

// ConnectAddress derives ws(s)://<host>/connect from a bare HTTP(S) hub origin.
func ConnectAddress(origin string) (string, error) {
	u, err := url.Parse(origin)
	if err != nil {
		return "", fmt.Errorf("pmcp: invalid hub origin: %w", err)
	}
	if (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "", fmt.Errorf("pmcp: expected an HTTP(S) hub origin, got %q", origin)
	}
	if (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" || u.User != nil {
		return "", fmt.Errorf("pmcp: expected a bare hub origin, got %q", origin)
	}
	scheme := "ws"
	if u.Scheme == "https" {
		scheme = "wss"
	}
	return scheme + "://" + u.Host + "/connect", nil
}

// BackoffDelay returns a full-jitter exponential delay capped at one minute.
func BackoffDelay(attempt int, rng func() float64) time.Duration {
	if attempt < 0 {
		attempt = 0
	}
	ceiling := backoffBase
	for range min(attempt, 6) {
		ceiling *= 2
	}
	if ceiling > backoffCap {
		ceiling = backoffCap
	}
	return time.Duration(rng() * float64(ceiling))
}

type schedule string

const (
	exponential schedule = "exponential"
	maxOnly     schedule = "max_only"
)

type behavior int

const (
	reconnect behavior = iota
	stopQuiet
	stopFatal
)

type ending struct {
	behavior behavior
	schedule schedule
	err      error
}

func endingForUpgrade(status int) ending {
	switch status {
	case http.StatusUnauthorized:
		return ending{behavior: stopFatal, err: &CredentialsError{Status: status}}
	case http.StatusForbidden:
		return ending{behavior: reconnect, schedule: maxOnly}
	default:
		return ending{behavior: reconnect, schedule: exponential}
	}
}

func endingForClose(err error) ending {
	code := int(websocket.CloseStatus(err))
	switch code {
	case 4000:
		return ending{behavior: stopQuiet}
	case 4001:
		return ending{behavior: stopFatal, err: &CredentialsError{Status: code}}
	case 4002:
		return ending{behavior: reconnect, schedule: maxOnly}
	default:
		return ending{behavior: reconnect, schedule: exponential}
	}
}

type socketState struct {
	ws       *websocket.Conn
	stopPing context.CancelFunc
}

type hubConn struct {
	address string
	token   string
	roles   Roles
	aliases *TypeScriptAliases

	mu      sync.RWMutex
	current *socketState
	closed  bool
}

func (c *hubConn) Read(ctx context.Context) (jsonrpc.Message, error) {
	for {
		ws := c.socket()
		if ws == nil {
			if c.isClosed() {
				return nil, io.EOF
			}
			if err := c.establish(ctx, exponential); err != nil {
				return nil, err
			}
			continue
		}

		kind, data, err := ws.Read(ctx)
		if err != nil {
			c.detach(ws)
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			if c.isClosed() {
				return nil, io.EOF
			}
			end := endingForClose(err)
			switch end.behavior {
			case stopQuiet:
				return nil, io.EOF
			case stopFatal:
				return nil, end.err
			default:
				if err := c.establish(ctx, end.schedule); err != nil {
					return nil, err
				}
				continue
			}
		}
		if kind != websocket.MessageText {
			continue
		}

		var control struct {
			Method string `json:"method"`
		}
		if json.Unmarshal(data, &control) == nil && control.Method == replacedMethod {
			continue
		}
		data = adaptSubscriptions(data)
		message, err := jsonrpc.DecodeMessage(data)
		if err != nil {
			return nil, err
		}
		return message, nil
	}
}

func (c *hubConn) Write(ctx context.Context, message jsonrpc.Message) error {
	data, err := jsonrpc.EncodeMessage(message)
	if err != nil {
		return err
	}
	ws := c.socket()
	if ws == nil {
		return nil
	}
	if err := ws.Write(ctx, websocket.MessageText, data); err != nil {
		// A response written onto a dying socket has no reader. Read owns reconnects.
		return nil
	}
	return nil
}

func (c *hubConn) Close() error {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil
	}
	c.closed = true
	state := c.current
	c.current = nil
	c.mu.Unlock()
	if state != nil {
		state.stopPing()
		_ = state.ws.Close(websocket.StatusNormalClosure, "client shutdown")
	}
	return nil
}

func (*hubConn) SessionID() string { return "" }

func (c *hubConn) establish(ctx context.Context, first schedule) error {
	attempt := 0
	next := first
	for {
		if next != "" {
			delayAttempt := attempt
			if next == maxOnly {
				delayAttempt = 6
			} else {
				attempt++
			}
			if err := sleep(ctx, BackoffDelay(delayAttempt, randomFloat64)); err != nil {
				return err
			}
		}
		if c.isClosed() {
			return io.EOF
		}

		header := http.Header{"Authorization": {"Bearer " + c.token}}
		ws, response, err := websocket.Dial(ctx, c.address, &websocket.DialOptions{HTTPHeader: header})
		if err != nil {
			status := 0
			if response != nil {
				status = response.StatusCode
			}
			end := endingForUpgrade(status)
			if end.behavior == stopFatal {
				return end.err
			}
			next = end.schedule
			continue
		}
		attempt = 0

		end, err := c.register(ctx, ws)
		if err == nil {
			c.install(ws)
			return nil
		}
		_ = ws.CloseNow()
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if end.behavior == stopFatal {
			return end.err
		}
		if end.behavior == stopQuiet {
			return io.EOF
		}
		next = end.schedule
	}
}

func (c *hubConn) register(ctx context.Context, ws *websocket.Conn) (ending, error) {
	// The params carry §23's optional typescriptAliases member: nil leaves the key
	// ABSENT, so a caller who declares no hints keeps sending exactly the historical
	// three-key frame, and the hub reads a missing member as "no hints", never as a
	// cleared map.
	request := struct {
		JSONRPC string `json:"jsonrpc"`
		ID      string `json:"id"`
		Method  string `json:"method"`
		Params  any    `json:"params"`
	}{
		JSONRPC: "2.0",
		ID:      registerID,
		Method:  registerMethod,
		Params: struct {
			ClientVersion     string             `json:"clientVersion"`
			ProtocolVersion   string             `json:"protocolVersion"`
			Roles             Roles              `json:"roles"`
			TypeScriptAliases *TypeScriptAliases `json:"typescriptAliases,omitempty"`
		}{clientVersion, ProtocolVersion, c.roles, c.aliases},
	}
	data, err := json.Marshal(request)
	if err != nil {
		return ending{behavior: stopFatal, err: err}, err
	}
	if err := ws.Write(ctx, websocket.MessageText, data); err != nil {
		end := endingForClose(err)
		return end, err
	}

	for {
		kind, data, err := ws.Read(ctx)
		if err != nil {
			end := endingForClose(err)
			return end, err
		}
		if kind != websocket.MessageText {
			continue
		}
		var response struct {
			ID     any             `json:"id"`
			Result json.RawMessage `json:"result"`
			Error  *struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(data, &response) != nil || response.ID != registerID {
			continue
		}
		if response.Error != nil {
			message := response.Error.Message
			if message == "" {
				message = "registration failed"
			}
			regErr := &RegistrationError{Message: message}
			return ending{behavior: stopFatal, err: regErr}, regErr
		}
		if len(response.Result) == 0 {
			continue
		}
		return ending{}, nil
	}
}

func (c *hubConn) socket() *websocket.Conn {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.current == nil {
		return nil
	}
	return c.current.ws
}

func (c *hubConn) isClosed() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.closed
}

func (c *hubConn) install(ws *websocket.Conn) {
	pingCtx, stopPing := context.WithCancel(context.Background())
	state := &socketState{ws: ws, stopPing: stopPing}
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		stopPing()
		_ = ws.CloseNow()
		return
	}
	c.current = state
	c.mu.Unlock()
	go pingLoop(pingCtx, ws)
}

func (c *hubConn) detach(ws *websocket.Conn) {
	c.mu.Lock()
	if c.current == nil || c.current.ws != ws {
		c.mu.Unlock()
		return
	}
	state := c.current
	c.current = nil
	c.mu.Unlock()
	state.stopPing()
	_ = ws.CloseNow()
}

func pingLoop(ctx context.Context, ws *websocket.Conn) {
	ticker := time.NewTicker(pingEvery)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			pingCtx, cancel := context.WithTimeout(ctx, pingEvery)
			err := ws.Ping(pingCtx)
			cancel()
			if err != nil {
				_ = ws.CloseNow()
				return
			}
		}
	}
}

func sleepContext(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// The hub deliberately retains resources/subscribe and resources/unsubscribe
// on its 2026-07-28 tunnel. The upstream Go SDK removed them in that revision,
// so present those two calls through its legacy handler while preserving all
// hub identity metadata.
func adaptSubscriptions(data []byte) []byte {
	var frame map[string]any
	if json.Unmarshal(data, &frame) != nil {
		return data
	}
	method, _ := frame["method"].(string)
	if method != "resources/subscribe" && method != "resources/unsubscribe" {
		return data
	}
	params, _ := frame["params"].(map[string]any)
	meta, _ := params["_meta"].(map[string]any)
	if meta == nil {
		return data
	}
	delete(meta, "io.modelcontextprotocol/protocolVersion")
	adapted, err := json.Marshal(frame)
	if err != nil {
		return data
	}
	return adapted
}

// CallerIdentity is the hub-asserted identity of the current caller.
type CallerIdentity struct {
	Principal string
	Roles     []string
}

// HasRole reports whether the caller has role or the built-in all role.
func (c CallerIdentity) HasRole(role string) bool {
	return slices.Contains(c.Roles, role) || slices.Contains(c.Roles, "all")
}

// Caller reads hub/principal and hub/roles from an MCP request's Params.GetMeta().
func Caller(meta map[string]any) CallerIdentity {
	identity, _ := meta["hub/principal"].(string)
	var roles []string
	switch values := meta["hub/roles"].(type) {
	case []string:
		roles = slices.Clone(values)
	case []any:
		for _, value := range values {
			if role, ok := value.(string); ok {
				roles = append(roles, role)
			}
		}
	}
	return CallerIdentity{Principal: identity, Roles: roles}
}

// Secret returns a cloned schema node marked writeOnly.
func Secret(schema *jsonschema.Schema) (*jsonschema.Schema, error) {
	if schema == nil {
		return nil, errors.New("pmcp: Secret called with a nil schema")
	}
	clone := schema.CloneSchemas()
	clone.WriteOnly = true
	return clone, nil
}

// Sensitive returns a cloned schema with each dot-separated property path
// marked writeOnly. It refuses missing paths so a typo cannot expose a secret.
func Sensitive(schema *jsonschema.Schema, paths ...string) (*jsonschema.Schema, error) {
	if schema == nil {
		return nil, errors.New("pmcp: Sensitive called with a nil schema")
	}
	clone := schema.CloneSchemas()
	for _, path := range paths {
		if err := markSensitive(clone, path); err != nil {
			return nil, err
		}
	}
	return clone, nil
}

func markSensitive(schema *jsonschema.Schema, path string) error {
	current := schema
	segments := strings.Split(path, ".")
	for _, segment := range segments {
		if segment == "" || current.Properties == nil || current.Properties[segment] == nil {
			return fmt.Errorf("pmcp: Sensitive: %q names no property in this schema", path)
		}
		current = current.Properties[segment]
	}
	current.WriteOnly = true
	return nil
}
