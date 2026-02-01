## Version 1 Summary

Implemented the V1 peer-to-peer video broadcast stack with a Go signaling server, browser client UI, and Termux run docs. The server serves the web client, manages rooms (one broadcaster/many receivers), and relays offers/answers/ICE over WebSocket, while the web app handles broadcaster/receiver flows with minimal buffering defaults.

### Changes
- Added signaling server at `peertopeervideo/server/main.go` with room registry and WS relay.
- Initialized Go module in `peertopeervideo/server/go.mod` (+ `go.sum`) using `github.com/gorilla/websocket`.
- Built web client in `peertopeervideo/web/index.html` and `peertopeervideo/web/app.js`.
- Added Termux setup/run docs in `peertopeervideo/README.md`.
- Added `peertopeervideo/Makefile` with cross-compile target for Android.

### Suggested Next Steps
- Build on laptop and copy the Android binary: `make build-android`.
- Open `http://<PHONE_IP>:10011` on two browsers and test broadcaster/receiver flow.
- For better NAT traversal, add TURN config to `rtcConfig` in `app.js`.
