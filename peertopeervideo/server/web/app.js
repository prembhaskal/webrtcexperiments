const roomInput = document.getElementById("roomInput");
const joinButton = document.getElementById("joinRoom");
const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");
const statusEl = document.getElementById("status");
const roomLink = document.getElementById("roomLink");
const cameraSelect = document.getElementById("cameraSelect");
const switchCameraButton = document.getElementById("switchCamera");
const toggleAudioMuteButton = document.getElementById("toggleAudioMute");
const toggleVideoMuteButton = document.getElementById("toggleVideoMute");
const hangUpButton = document.getElementById("hangUp");
const callControls = document.querySelector(".call-controls");
const joinControls = document.querySelector(".join-controls");

const state = {
  ws: null,
  room: null,
  clientId: null,
  sessionId: null,
  peerId: null,
  localStream: null,
  pc: null,
  videoDevices: [],
  currentVideoDeviceIndex: 0,
  isAudioMuted: false,
  isVideoMuted: false,
};

const rtcConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

function setStatus(message) {
  statusEl.textContent = message;
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

function getSessionId() {
  const stored = localStorage.getItem("sessionId");
  if (stored) return stored;
  const generated =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
  localStorage.setItem("sessionId", generated);
  return generated;
}

async function populateCameraSelect() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    state.videoDevices = devices.filter((d) => d.kind === "videoinput");

    if (state.videoDevices.length > 1) {
      switchCameraButton.style.display = "flex";
    }
  } catch (err) {
    console.error("Error populating camera select:", err);
  }
}

async function ensureLocalStream(deviceId) {
  if (state.localStream) {
    state.localStream.getTracks().forEach((track) => track.stop());
  }

  const constraints = {
    audio: true,
    video: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
    },
  };

  state.localStream = await navigator.mediaDevices.getUserMedia(constraints);
  localVideo.srcObject = state.localStream;

  // Restore mute states from our state object
  state.localStream
    .getAudioTracks()
    .forEach((track) => (track.enabled = !state.isAudioMuted));
  state.localStream
    .getVideoTracks()
    .forEach((track) => (track.enabled = !state.isVideoMuted));

  updateMuteButtons();

  if (state.pc) {
    // Replace audio tracks
    const audioTrack = state.localStream.getAudioTracks()[0];
    const audioSender = state.pc
      .getSenders()
      .find((s) => s.track && s.track.kind === "audio");
    if (audioSender) {
      await audioSender.replaceTrack(audioTrack);
    }

    // Replace video tracks
    const videoTrack = state.localStream.getVideoTracks()[0];
    const videoSender = state.pc
      .getSenders()
      .find((s) => s.track && s.track.kind === "video");
    if (videoSender) {
      await videoSender.replaceTrack(videoTrack);
    }
  }

  return state.localStream;
}

function connectAndJoin() {
  state.room = roomInput.value.trim() || randomRoom();
  roomInput.value = state.room;
  setRoomLink(state.room);
  state.sessionId = getSessionId();

  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    send({ type: "join", room: state.room, sessionId: state.sessionId });
    return;
  }

  state.ws = new WebSocket(wsUrl());
  state.ws.onopen = () => {
    setStatus("Connected. Joining room...");
    send({ type: "join", room: state.room, sessionId: state.sessionId });
  };
  state.ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    handleSignal(msg);
  };
  state.ws.onclose = () => {
    setStatus("Disconnected from server.");
    resetUI();
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
      setStatus("Joined room. Waiting for someone to join...");
      showCallUI();
      break;
    case "waiting":
      setStatus("Waiting for someone to join...");
      break;
    case "peer-joined":
      state.peerId = msg.clientId;
      setStatus("Peer connected.");
      handlePeerJoined(msg.offerer);
      break;
    case "peer-left":
      setStatus("Peer left. Waiting for someone to join...");
      cleanupPeer();
      break;
    case "offer":
      handleOffer(msg.fromId, msg.sdp);
      break;
    case "answer":
      handleAnswer(msg.fromId, msg.sdp);
      break;
    case "ice":
      handleRemoteIce(msg.fromId, msg.candidate);
      break;
    case "error":
      setStatus(`Error: ${msg.error}`);
      break;
    default:
      break;
  }
}

async function handlePeerJoined(offerer) {
  await ensureLocalStream(
    state.videoDevices[state.currentVideoDeviceIndex]?.deviceId
  );
  createPeerConnection();
  if (offerer) {
    const offer = await state.pc.createOffer();
    await state.pc.setLocalDescription(offer);
    send({ type: "offer", targetId: state.peerId, sdp: offer.sdp });
  }
}

function createPeerConnection() {
  cleanupPeer();
  const pc = new RTCPeerConnection(rtcConfig);

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      send({
        type: "ice",
        targetId: state.peerId,
        candidate: event.candidate,
      });
    }
  };

  pc.ontrack = (event) => {
    remoteVideo.srcObject = event.streams[0];
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed" || pc.connectionState === "closed") {
      cleanupPeer();
      setStatus("Connection ended. Waiting for someone to join...");
    }
  };

  state.localStream.getTracks().forEach((track) => {
    pc.addTrack(track, state.localStream);
  });

  state.pc = pc;
}

function cleanupPeer() {
  if (state.pc) {
    state.pc.close();
    state.pc = null;
  }
  remoteVideo.srcObject = null;
  state.peerId = null;
}

async function handleOffer(fromId, sdp) {
  state.peerId = fromId;
  await ensureLocalStream(
    state.videoDevices[state.currentVideoDeviceIndex]?.deviceId
  );
  if (!state.pc) {
    createPeerConnection();
  }
  await state.pc.setRemoteDescription({ type: "offer", sdp });
  const answer = await state.pc.createAnswer();
  await state.pc.setLocalDescription(answer);
  send({ type: "answer", targetId: fromId, sdp: answer.sdp });
}

async function handleAnswer(fromId, sdp) {
  if (!state.pc) return;
  await state.pc.setRemoteDescription({ type: "answer", sdp });
}

function handleRemoteIce(fromId, candidate) {
  if (!candidate || !state.pc) return;
  state.pc.addIceCandidate(candidate).catch(() => {});
}

async function switchCamera() {
  if (state.videoDevices.length > 1) {
    state.currentVideoDeviceIndex =
      (state.currentVideoDeviceIndex + 1) % state.videoDevices.length;
    const newDeviceId =
      state.videoDevices[state.currentVideoDeviceIndex].deviceId;
    await ensureLocalStream(newDeviceId);
  }
}

function updateMuteButtons() {
  toggleAudioMuteButton.textContent = state.isAudioMuted ? "🔇" : "🎤";
  toggleAudioMuteButton.classList.toggle("muted", state.isAudioMuted);

  toggleVideoMuteButton.textContent = state.isVideoMuted ? "📸" : "📷";
  toggleVideoMuteButton.classList.toggle("muted", state.isVideoMuted);
}

function toggleAudioMute() {
  if (!state.localStream) return;
  state.isAudioMuted = !state.isAudioMuted;
  state.localStream
    .getAudioTracks()
    .forEach((track) => (track.enabled = !state.isAudioMuted));
  updateMuteButtons();
}

function toggleVideoMute() {
  if (!state.localStream) return;
  state.isVideoMuted = !state.isVideoMuted;
  state.localStream
    .getVideoTracks()
    .forEach((track) => (track.enabled = !state.isVideoMuted));
  updateMuteButtons();
}

function hangUp() {
  if (state.ws) {
    state.ws.close();
  }
  cleanupPeer();
  if (state.localStream) {
    state.localStream.getTracks().forEach((track) => track.stop());
    state.localStream = null;
  }
  resetUI();
}

function showCallUI() {
  joinControls.style.display = "none";
  roomLink.style.display = "none";
  callControls.style.display = "flex";
}

function resetUI() {
  joinControls.style.display = "flex";
  callControls.style.display = "none";
  const url = new URL(location.href);
  url.searchParams.delete("room");
  roomLink.textContent = "";
  setStatus("Enter a room and join.");
}

joinButton.addEventListener("click", async () => {
  setStatus("Requesting camera/mic...");
  await ensureLocalStream();
  await populateCameraSelect();
  connectAndJoin();
});

switchCameraButton.addEventListener("click", switchCamera);
toggleAudioMuteButton.addEventListener("click", toggleAudioMute);
toggleVideoMuteButton.addEventListener("click", toggleVideoMute);
hangUpButton.addEventListener("click", hangUp);

// No need for this anymore as switchCamera cycles.
// cameraSelect.addEventListener("change", async () => { ... });

const queryRoom = new URLSearchParams(location.search).get("room");
if (queryRoom) {
  roomInput.value = queryRoom;
}
