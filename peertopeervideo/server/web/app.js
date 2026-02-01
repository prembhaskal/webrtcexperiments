const roomInput = document.getElementById("roomInput");
const startBroadcastButton = document.getElementById("startBroadcast");
const joinReceiverButton = document.getElementById("joinReceiver");
const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");
const logEl = document.getElementById("log");
const roomLink = document.getElementById("roomLink");

const state = {
  ws: null,
  role: null,
  room: null,
  clientId: null,
  localStream: null,
  peerConnections: new Map(),
  pendingCandidates: new Map(),
};

const rtcConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

function log(message) {
  const time = new Date().toLocaleTimeString();
  logEl.textContent = `[${time}] ${message}\n` + logEl.textContent;
}

function wsUrl() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
}

function randomRoom() {
  return Math.random().toString(36).slice(2, 8);
}

function setRoomLink(room) {
  const url = new URL(location.href);
  url.searchParams.set("room", room);
  roomLink.textContent = `Room link: ${url.toString()}`;
}

async function ensureLocalStream() {
  if (state.localStream) return state.localStream;
  state.localStream = await navigator.mediaDevices.getUserMedia({
    video: true,
    audio: true,
  });
  localVideo.srcObject = state.localStream;
  return state.localStream;
}

function connectAndJoin(role) {
  state.role = role;
  state.room = roomInput.value.trim() || randomRoom();
  roomInput.value = state.room;
  setRoomLink(state.room);

  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    send({ type: "join", room: state.room, role: state.role });
    return;
  }

  state.ws = new WebSocket(wsUrl());
  state.ws.onopen = () => {
    log("connected to signaling server");
    send({ type: "join", room: state.room, role: state.role });
  };
  state.ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    handleSignal(msg);
  };
  state.ws.onclose = () => {
    log("disconnected from signaling server");
  };
}

function send(msg) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  state.ws.send(JSON.stringify(msg));
}

function handleSignal(msg) {
  switch (msg.type) {
    case "joined":
      state.clientId = msg.clientId;
      log(`joined room ${msg.room} as ${msg.role}`);
      break;
    case "receiver-joined":
      if (state.role === "broadcaster") {
        handleReceiverJoined(msg.clientId);
      }
      break;
    case "offer":
      if (state.role === "receiver") {
        handleOffer(msg.fromId, msg.sdp);
      }
      break;
    case "answer":
      if (state.role === "broadcaster") {
        handleAnswer(msg.fromId, msg.sdp);
      }
      break;
    case "ice":
      handleRemoteIce(msg.fromId, msg.candidate);
      break;
    case "broadcaster-left":
      log("broadcaster disconnected");
      remoteVideo.srcObject = null;
      break;
    case "receiver-left":
      if (state.role === "broadcaster") {
        closePeer(msg.clientId);
        log(`receiver left: ${msg.clientId}`);
      }
      break;
    case "error":
      log(`error: ${msg.error}`);
      break;
    default:
      break;
  }
}

function createPeerConnection(remoteId) {
  const pc = new RTCPeerConnection(rtcConfig);

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      send({
        type: "ice",
        targetId: remoteId,
        candidate: event.candidate,
      });
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed" || pc.connectionState === "closed") {
      closePeer(remoteId);
    }
  };

  if (state.role === "receiver") {
    pc.ontrack = (event) => {
      remoteVideo.srcObject = event.streams[0];
    };
  }

  state.peerConnections.set(remoteId, pc);
  flushPending(remoteId, pc);
  return pc;
}

function closePeer(remoteId) {
  const pc = state.peerConnections.get(remoteId);
  if (pc) {
    pc.close();
    state.peerConnections.delete(remoteId);
  }
}

function addPending(remoteId, candidate) {
  if (!state.pendingCandidates.has(remoteId)) {
    state.pendingCandidates.set(remoteId, []);
  }
  state.pendingCandidates.get(remoteId).push(candidate);
}

function flushPending(remoteId, pc) {
  const queued = state.pendingCandidates.get(remoteId);
  if (!queued || queued.length === 0) return;
  queued.forEach((candidate) => pc.addIceCandidate(candidate).catch(() => {}));
  state.pendingCandidates.delete(remoteId);
}

async function handleReceiverJoined(receiverId) {
  const stream = await ensureLocalStream();
  const pc = createPeerConnection(receiverId);
  stream.getTracks().forEach((track) => pc.addTrack(track, stream));
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  send({ type: "offer", targetId: receiverId, sdp: offer.sdp });
}

async function handleOffer(fromId, sdp) {
  const pc = createPeerConnection(fromId);
  await pc.setRemoteDescription({ type: "offer", sdp });
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  send({ type: "answer", targetId: fromId, sdp: answer.sdp });
}

async function handleAnswer(fromId, sdp) {
  const pc = state.peerConnections.get(fromId);
  if (!pc) return;
  await pc.setRemoteDescription({ type: "answer", sdp });
}

function handleRemoteIce(fromId, candidate) {
  if (!candidate) return;
  const pc = state.peerConnections.get(fromId);
  if (pc) {
    pc.addIceCandidate(candidate).catch(() => {});
  } else {
    addPending(fromId, candidate);
  }
}

startBroadcastButton.addEventListener("click", async () => {
  await ensureLocalStream();
  connectAndJoin("broadcaster");
});

joinReceiverButton.addEventListener("click", () => {
  connectAndJoin("receiver");
});

const queryRoom = new URLSearchParams(location.search).get("room");
if (queryRoom) {
  roomInput.value = queryRoom;
}
