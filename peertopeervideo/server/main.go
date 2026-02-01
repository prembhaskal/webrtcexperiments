package main

import (
	"crypto/rand"
	"embed"
	"encoding/hex"
	"encoding/json"
	"io/fs"
	"log"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

type SignalMessage struct {
	Type      string          `json:"type"`
	Room      string          `json:"room,omitempty"`
	SessionID string          `json:"sessionId,omitempty"`
	ClientID  string          `json:"clientId,omitempty"`
	FromID    string          `json:"fromId,omitempty"`
	TargetID  string          `json:"targetId,omitempty"`
	SDP       string          `json:"sdp,omitempty"`
	Candidate json.RawMessage `json:"candidate,omitempty"`
	Offerer   bool            `json:"offerer,omitempty"`
	Status    string          `json:"status,omitempty"`
	Error     string          `json:"error,omitempty"`
}

type Client struct {
	id               string
	sessionID        string
	room             string
	conn             *websocket.Conn
	send             chan SignalMessage
	disconnectedAt   time.Time
	disconnectTimer  *time.Timer
}

type Room struct {
	peers    map[string]*Client
	sessions map[string]*Client
}

type Hub struct {
	mu    sync.Mutex
	rooms map[string]*Room
}

func newHub() *Hub {
	return &Hub{
		rooms: make(map[string]*Room),
	}
}

func (h *Hub) getOrCreateRoom(id string) *Room {
	room := h.rooms[id]
	if room == nil {
		room = &Room{
			peers:    make(map[string]*Client),
			sessions: make(map[string]*Client),
		}
		h.rooms[id] = room
	}
	return room
}

func (h *Hub) handleJoin(c *Client, msg SignalMessage) {
	if msg.Room == "" {
		c.sendMessage(SignalMessage{Type: "error", Error: "room is required"})
		return
	}
	if msg.SessionID == "" {
		c.sendMessage(SignalMessage{Type: "error", Error: "sessionId is required"})
		return
	}

	h.mu.Lock()
	defer h.mu.Unlock()

	room := h.getOrCreateRoom(msg.Room)

	if existing := room.sessions[msg.SessionID]; existing != nil {
		if existing.disconnectTimer != nil {
			existing.disconnectTimer.Stop()
		}
		delete(room.peers, existing.id)
		delete(room.sessions, existing.sessionID)
	}

	connectedCount := 0
	for _, peer := range room.peers {
		if peer.disconnectedAt.IsZero() {
			connectedCount++
		}
	}

	if connectedCount >= 2 {
		c.sendMessage(SignalMessage{Type: "error", Error: "room full"})
		return
	}

	if connectedCount < 2 && len(room.peers) >= 2 {
		for id, peer := range room.peers {
			if !peer.disconnectedAt.IsZero() {
				if peer.disconnectTimer != nil {
					peer.disconnectTimer.Stop()
				}
				delete(room.peers, id)
				delete(room.sessions, peer.sessionID)
				break
			}
		}
	}

	c.room = msg.Room
	c.sessionID = msg.SessionID
	c.sendMessage(SignalMessage{
		Type:     "joined",
		Room:     c.room,
		ClientID: c.id,
	})

	room.peers[c.id] = c
	room.sessions[c.sessionID] = c

	other := room.otherConnectedPeer(c.id)
	if other == nil {
		c.sendMessage(SignalMessage{Type: "waiting", Status: "waiting"})
		return
	}

	other.sendMessage(SignalMessage{
		Type:     "peer-joined",
		ClientID: c.id,
		Offerer:  false,
	})
	c.sendMessage(SignalMessage{
		Type:     "peer-joined",
		ClientID: other.id,
		Offerer:  true,
	})
}

func (h *Hub) relay(c *Client, msg SignalMessage) {
	h.mu.Lock()
	room := h.rooms[c.room]
	h.mu.Unlock()
	if room == nil {
		return
	}

	msg.FromID = c.id

	if msg.TargetID == "" {
		if other := room.otherConnectedPeer(c.id); other != nil {
			msg.TargetID = other.id
		}
	}
	if msg.TargetID == "" {
		return
	}
	if peer := room.peers[msg.TargetID]; peer != nil {
		peer.sendMessage(msg)
	}
}

func (h *Hub) handleWS(w http.ResponseWriter, r *http.Request) {
	upgrader := websocket.Upgrader{
		CheckOrigin: func(r *http.Request) bool {
			return true
		},
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("upgrade error: %v", err)
		return
	}

	client := &Client{
		id:   randomID(),
		conn: conn,
		send: make(chan SignalMessage, 16),
	}

	go client.writeLoop()
	client.readLoop(h)
}

func (c *Client) sendMessage(msg SignalMessage) {
	select {
	case c.send <- msg:
	default:
	}
}

func (c *Client) writeLoop() {
	for msg := range c.send {
		if err := c.conn.WriteJSON(msg); err != nil {
			break
		}
	}
	_ = c.conn.Close()
}

func (c *Client) readLoop(h *Hub) {
	defer func() {
		h.handleDisconnect(c)
		close(c.send)
	}()

	for {
		var msg SignalMessage
		if err := c.conn.ReadJSON(&msg); err != nil {
			return
		}

		if c.room == "" {
			if msg.Type != "join" {
				c.sendMessage(SignalMessage{Type: "error", Error: "must join first"})
				continue
			}
			h.handleJoin(c, msg)
			continue
		}

		switch msg.Type {
		case "offer", "answer", "ice":
			h.relay(c, msg)
		}
	}
}

func randomID() string {
	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		return "unknown"
	}
	return hex.EncodeToString(buf)
}

func (h *Hub) handleDisconnect(c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()

	room := h.rooms[c.room]
	if room == nil {
		return
	}

	peer, ok := room.peers[c.id]
	if !ok || peer != c {
		return
	}

	c.disconnectedAt = time.Now()
	if c.disconnectTimer != nil {
		c.disconnectTimer.Stop()
	}

	if other := room.otherConnectedPeer(c.id); other != nil {
		other.sendMessage(SignalMessage{Type: "peer-left", ClientID: c.id})
		other.sendMessage(SignalMessage{Type: "waiting", Status: "waiting"})
	}

	c.disconnectTimer = time.AfterFunc(5*time.Second, func() {
		h.finalizeDisconnect(c.room, c.id, c.sessionID)
	})
}

func (h *Hub) finalizeDisconnect(roomID, clientID, sessionID string) {
	h.mu.Lock()
	defer h.mu.Unlock()

	room := h.rooms[roomID]
	if room == nil {
		return
	}

	peer := room.peers[clientID]
	if peer == nil || peer.sessionID != sessionID {
		return
	}
	if peer.disconnectedAt.IsZero() {
		return
	}

	delete(room.peers, clientID)
	delete(room.sessions, sessionID)

	if len(room.peers) == 0 {
		delete(h.rooms, roomID)
	}
}

func (r *Room) otherConnectedPeer(excludeID string) *Client {
	for id, peer := range r.peers {
		if id == excludeID {
			continue
		}
		if peer.disconnectedAt.IsZero() {
			return peer
		}
	}
	return nil
}

//go:embed web/*
var webFiles embed.FS

func main() {
	hub := newHub()

	webDir, err := fs.Sub(webFiles, "web")
	if err != nil {
		log.Fatalf("failed to load embedded web assets: %v", err)
	}

	http.Handle("/", http.FileServer(http.FS(webDir)))
	http.HandleFunc("/ws", hub.handleWS)

	addr := getEnv("ADDR", ":10011")
	certFile := os.Getenv("TLS_CERT")
	keyFile := os.Getenv("TLS_KEY")

	if certFile != "" && keyFile != "" {
		log.Printf("signaling server listening with TLS on %s", addr)
		log.Fatal(http.ListenAndServeTLS(addr, certFile, keyFile, nil))
	}

	log.Printf("signaling server listening on %s", addr)
	log.Fatal(http.ListenAndServe(addr, nil))
}

func getEnv(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
