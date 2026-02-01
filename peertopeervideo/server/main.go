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

	"github.com/gorilla/websocket"
)

const (
	roleBroadcaster = "broadcaster"
	roleReceiver    = "receiver"
)

type SignalMessage struct {
	Type      string          `json:"type"`
	Room      string          `json:"room,omitempty"`
	Role      string          `json:"role,omitempty"`
	ClientID  string          `json:"clientId,omitempty"`
	FromID    string          `json:"fromId,omitempty"`
	TargetID  string          `json:"targetId,omitempty"`
	SDP       string          `json:"sdp,omitempty"`
	Candidate json.RawMessage `json:"candidate,omitempty"`
	Error     string          `json:"error,omitempty"`
}

type Client struct {
	id   string
	role string
	room string
	conn *websocket.Conn
	send chan SignalMessage
}

type Room struct {
	broadcaster *Client
	receivers   map[string]*Client
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
			receivers: make(map[string]*Client),
		}
		h.rooms[id] = room
	}
	return room
}

func (h *Hub) removeClient(c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()

	room := h.rooms[c.room]
	if room == nil {
		return
	}

	switch c.role {
	case roleBroadcaster:
		if room.broadcaster == c {
			room.broadcaster = nil
			for _, receiver := range room.receivers {
				receiver.sendMessage(SignalMessage{Type: "broadcaster-left"})
			}
		}
	case roleReceiver:
		if room.receivers != nil {
			delete(room.receivers, c.id)
			if room.broadcaster != nil {
				room.broadcaster.sendMessage(SignalMessage{
					Type:     "receiver-left",
					ClientID: c.id,
				})
			}
		}
	}

	if room.broadcaster == nil && len(room.receivers) == 0 {
		delete(h.rooms, c.room)
	}
}

func (h *Hub) handleJoin(c *Client, msg SignalMessage) {
	if msg.Room == "" {
		c.sendMessage(SignalMessage{Type: "error", Error: "room is required"})
		return
	}
	if msg.Role != roleBroadcaster && msg.Role != roleReceiver {
		c.sendMessage(SignalMessage{Type: "error", Error: "role must be broadcaster or receiver"})
		return
	}

	h.mu.Lock()
	defer h.mu.Unlock()

	room := h.getOrCreateRoom(msg.Room)
	switch msg.Role {
	case roleBroadcaster:
		if room.broadcaster != nil {
			c.sendMessage(SignalMessage{Type: "error", Error: "broadcaster already exists"})
			return
		}
		room.broadcaster = c
	case roleReceiver:
		room.receivers[c.id] = c
	}

	c.room = msg.Room
	c.role = msg.Role
	c.sendMessage(SignalMessage{
		Type:     "joined",
		Room:     c.room,
		Role:     c.role,
		ClientID: c.id,
	})

	if c.role == roleBroadcaster {
		for _, receiver := range room.receivers {
			c.sendMessage(SignalMessage{
				Type:     "receiver-joined",
				ClientID: receiver.id,
			})
		}
	}

	if c.role == roleReceiver && room.broadcaster != nil {
		room.broadcaster.sendMessage(SignalMessage{
			Type:     "receiver-joined",
			ClientID: c.id,
		})
	}
}

func (h *Hub) relay(c *Client, msg SignalMessage) {
	h.mu.Lock()
	room := h.rooms[c.room]
	h.mu.Unlock()
	if room == nil {
		return
	}

	msg.FromID = c.id

	switch c.role {
	case roleBroadcaster:
		if msg.TargetID == "" {
			return
		}
		if receiver := room.receivers[msg.TargetID]; receiver != nil {
			receiver.sendMessage(msg)
		}
	case roleReceiver:
		if room.broadcaster == nil {
			return
		}
		if msg.TargetID == "" {
			msg.TargetID = room.broadcaster.id
		}
		if msg.TargetID == room.broadcaster.id {
			room.broadcaster.sendMessage(msg)
		}
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
		h.removeClient(c)
		close(c.send)
	}()

	for {
		var msg SignalMessage
		if err := c.conn.ReadJSON(&msg); err != nil {
			return
		}

		if c.role == "" {
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
