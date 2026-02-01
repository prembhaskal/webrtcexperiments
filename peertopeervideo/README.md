# Peer to Peer Video V1

Minimal WebRTC broadcast setup with a Go signaling server that can run on an Android phone (Termux) and browser clients for broadcaster and receivers.

## Requirements
- Android phone with Termux installed
- Latest Go on your laptop (recommended)
- Two browsers on the same network (or internet reachable phone IP)

## Termux setup
```sh
pkg update
pkg install openssh
```

## Build on laptop (recommended)
```sh
cd peertopeervideo
make build-android
```

Copy the binary to the phone (example using scp):
```sh
scp bin/peertopeervideo-server-android <PHONE_USER>@<PHONE_IP>:/data/data/com.termux/files/home/
```

Copy the startup script:
```sh
scp start_server.sh <PHONE_USER>@<PHONE_IP>:/data/data/com.termux/files/home/
```

## Run the server (on phone)
```sh
chmod +x /data/data/com.termux/files/home/peertopeervideo-server-android
chmod +x /data/data/com.termux/files/home/start_server.sh
/data/data/com.termux/files/home/start_server.sh
```

The server listens on `:10011` and serves the embedded web client.

## Open the client
On any device on the same network, open:
```
http://<PHONE_IP>:10011
```

## Usage
1. Click **Start broadcast** on the broadcaster device.
2. Copy the room link and open it in another browser.
3. Click **Join as receiver** to start receiving the video.

## Notes
- The signaling server only relays WebRTC offers/answers/ICE.
- Default STUN server is `stun:stun.l.google.com:19302`.
- For wider NAT compatibility, add a TURN server later.

## HTTPS (self-signed, recommended for phones)
Browsers require HTTPS to access camera/mic on non-localhost URLs. You can use a self-signed cert on your home network.

Generate a self-signed cert on your laptop:
```sh
openssl req -x509 -newkey rsa:2048 -sha256 -days 365 -nodes \
  -keyout server.key -out server.crt -subj "/CN=peertopeervideo.local"
```

Copy the certs to the phone next to the binary and `start_server.sh`:
```sh
scp server.crt server.key <PHONE_USER>@<PHONE_IP>:/data/data/com.termux/files/home/
```

The startup script will detect `server.crt` and `server.key` and enable HTTPS automatically.

Open:
```
https://<PHONE_IP>:10011
```

You will need to trust the cert once on each phone.
