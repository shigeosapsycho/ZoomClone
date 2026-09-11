import type { RosterEntry } from "@zoomclone/protocol";
import type { LocalTracks } from "./media";
import type { ConnectionStatus } from "./signaling";
import type { RoomView } from "./state";

export type UiModel = {
  screen: "join" | "waiting" | "room" | "ended" | "closed";
  status: ConnectionStatus;
  view: RoomView;
  roomCode: string;
  sessionId: string | null;
  localState: { muted: boolean; videoOff: boolean };
  levels: Record<string, number>;
  error: string | null;
  sinceMs: number | null;
};

export type UiActions = {
  join: (input: { code: string; name: string; token: string }) => void;
  leave: () => void;
  toggleMic: () => void;
  toggleCamera: () => void;
  toggleHand: () => void;
  react: (emoji: string) => void;
  chat: (body: string) => void;
  admit: (participantId: string) => void;
  deny: (participantId: string) => void;
  mute: (participantId: string) => void;
  remove: (participantId: string) => void;
  setLock: (locked: boolean) => void;
  end: () => void;
  setLayer: (trackId: string, maxLayer: number) => void;
};

export type Ui = {
  render: (model: UiModel) => void;
  attachFeed: (trackId: string, kind: "audio" | "video", track: MediaStreamTrack) => void;
  detachFeed: (trackId: string) => void;
  attachLocal: (tracks: LocalTracks) => void;
  frames: (trackId: string) => number;
  tape: (seq: number, text: string) => void;
};

const REACTIONS = ["👍", "👏", "👋"];
const LOCAL = "you";
const TAPE_KEEP = 40;
const METER_SEGMENTS = 10;

type Tile = {
  root: HTMLElement;
  picture: HTMLElement;
  video: HTMLVideoElement;
  stream: MediaStream;
  lamp: HTMLElement;
  offNotice: HTMLElement;
  offText: HTMLElement;
  name: HTMLElement;
  badges: HTMLElement;
  meter: HTMLElement[];
  reaction: HTMLElement | null;
};

type RosterRow = {
  li: HTMLElement;
  name: HTMLElement;
  flags: HTMLElement;
  controls: HTMLElement;
  /** Which set of host controls the row carries, so they are rebuilt only when that changes. */
  controlsFor: string;
};

type WaiterRow = { li: HTMLElement; name: HTMLElement };
type Counter = { node: HTMLElement; value: HTMLElement };

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

function setData(node: HTMLElement, key: string, value: string): void {
  if (node.dataset[key] !== value) node.dataset[key] = value;
}

function setPressed(button: HTMLButtonElement, pressed: boolean): void {
  const value = String(pressed);
  if (button.getAttribute("aria-pressed") !== value) button.setAttribute("aria-pressed", value);
}

function rocker(
  label: string,
  onClick: () => void,
  opts: { pressed?: boolean; tone?: string; small?: boolean; testId?: string } = {},
): HTMLButtonElement {
  const button = el("button", `rocker${opts.small ? " small" : ""}`, label);
  button.type = "button";
  if (opts.pressed !== undefined) button.setAttribute("aria-pressed", String(opts.pressed));
  if (opts.tone) button.dataset["tone"] = opts.tone;
  if (opts.testId) button.dataset["testid"] = opts.testId;
  button.addEventListener("click", onClick);
  return button;
}

const SOURCE_ORDER = ["mic", "camera", "screen"] as const;

/** The sources a participant publishes, as legend tokens; a screen share's audio folds into "screen". */
function publishedSources(model: UiModel, participantId: string): string[] {
  const sources = new Set<string>();
  for (const track of model.view.tracks) {
    if (track.owner !== participantId) continue;
    sources.add(track.source === "screen_audio" ? "screen" : track.source);
  }
  return SOURCE_ORDER.filter((source) => sources.has(source));
}

function fmtClock(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * Imperative renderer. Every element that can hold focus, a click or typed text (the rockers,
 * the chat and join inputs, the roster rows) is built once and updated in place, so a render
 * tick never pulls a button out from under the pointer or wipes a half-typed message. Tiles are
 * keyed by participant id and kept across renders so their <video> elements never restart.
 */
export function createUi(root: HTMLElement, actions: UiActions): Ui {
  const tiles = new Map<string, Tile>();
  const feedOwner = new Map<string, string>();
  const feedTracks = new Map<string, MediaStreamTrack>();
  const frameCounts = new Map<string, number>();
  const frameLoops = new Map<string, symbol>();
  const tapeItems: Array<{ seq: number; text: string }> = [];
  let tapeDirty = true;
  let localTracks: LocalTracks = { audio: null, video: null };
  let localCaptured = false;
  let lastModel: UiModel | null = null;
  let shownScreen: UiModel["screen"] | null = null;

  // ---- bands ----
  const tallyBar = el("header", "tally-bar legend");
  const panelBand = el("section", "panel-band");
  const stage = el("section", "stage");
  const rack = el("aside", "rack");
  const strip = el("footer", "strip");
  const tape = el("div", "tape legend");
  tape.dataset["testid"] = "tape";

  // ---- tally bar ----
  const air = el("span", "air");
  const airLamp = el("span", "lamp");
  const airStatus = el("span");
  airStatus.dataset["testid"] = "air-status";
  airStatus.setAttribute("aria-live", "polite");
  const airClock = el("span", "clock");
  air.append(airLamp, airStatus, airClock);
  const counters = { room: counter("room"), epoch: counter("epoch"), seq: counter("seq") };
  const lockButton = rocker(
    "lock room",
    () => actions.setLock(!(lastModel?.view.meta?.locked ?? false)),
    { pressed: false, tone: "amber", small: true, testId: "lock" },
  );
  const endButton = rocker("end for everyone", () => actions.end(), {
    small: true,
    testId: "end",
  });
  tallyBar.append(
    air,
    counters.room.node,
    counters.epoch.node,
    counters.seq.node,
    el("span", "spacer"),
    lockButton,
    endButton,
  );

  // ---- control strip ----
  const micButton = rocker("mic on", () => actions.toggleMic(), { pressed: true, testId: "mic" });
  const cameraButton = rocker("camera on", () => actions.toggleCamera(), {
    pressed: true,
    testId: "camera",
  });
  const handButton = rocker("raise hand", () => actions.toggleHand(), {
    pressed: false,
    tone: "amber",
    testId: "hand",
  });
  const reactions = el("div", "reactions");
  for (const emoji of REACTIONS) {
    reactions.append(rocker(emoji, () => actions.react(emoji), { testId: `react-${emoji}` }));
  }
  const leaveButton = rocker("leave room", () => actions.leave(), { testId: "leave" });
  strip.append(micButton, cameraButton, handButton, reactions, el("span", "spacer"), leaveButton);

  // ---- rack ----
  const greenModule = el("section", "module");
  const greenTitle = el("h2", "legend");
  const greenList = el("ul", "green-room");
  greenList.dataset["testid"] = "green-room";
  const greenEmpty = el("li", "badge", "nobody waiting");
  greenList.append(greenEmpty);
  greenModule.append(greenTitle, greenList);
  const waiterRows = new Map<string, WaiterRow>();

  const rosterModule = el("section", "module");
  const rosterTitle = el("h2", "legend");
  const rosterList = el("ul", "roster");
  rosterList.dataset["testid"] = "roster";
  rosterModule.append(rosterTitle, rosterList);
  const rosterRows = new Map<string, RosterRow>();

  const talk = el("section", "module talk");
  const chatLines = el("div", "lines");
  chatLines.dataset["testid"] = "chat-lines";
  const chatForm = el("form");
  // A visible label, like the join fields: a placeholder alone is not a name.
  const chat = labelled("message", "chat", "Type a message");
  const chatInput = chat.input;
  chatInput.dataset["testid"] = "chat-input";
  const chatSend = rocker("send", () => undefined, { small: true, testId: "chat-send" });
  chatSend.type = "submit";
  chatForm.append(chat.label, chatSend);
  chatForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const body = chatInput.value.trim();
    if (body) actions.chat(body);
    chatInput.value = "";
  });
  talk.append(el("h2", "legend", "Talk"), chatLines, chatForm);
  rack.append(greenModule, rosterModule, talk);
  let renderedChat: RoomView["chat"] | null = null;
  let renderedNames: RoomView["roster"] | null = null;

  // ---- join panel and notices ----
  const joinForm = el("form", "join");
  joinForm.dataset["testid"] = "join-form";
  const code = labelled("room code", "code", "xxx-xxxx-xxx");
  code.input.setAttribute("autocapitalize", "off");
  code.input.spellcheck = false;
  const name = labelled("your name", "name", "");
  const token = labelled("host token (optional)", "token", "");
  const joinButton = rocker("join", () => undefined, { testId: "join" });
  joinButton.type = "submit";
  joinForm.append(
    el("h1", "legend", "Join a room"),
    code.label,
    name.label,
    token.label,
    joinButton,
  );
  joinForm.addEventListener("submit", (event) => {
    event.preventDefault();
    joinButton.disabled = true;
    actions.join({
      code: code.input.value.trim(),
      name: name.input.value.trim(),
      token: token.input.value.trim(),
    });
  });

  const waitBox = el("div", "join");
  waitBox.append(
    el("h1", "legend", "Green room"),
    el("p", undefined, "The host has been told you are here. This page updates on its own."),
    rocker("leave room", () => actions.leave(), { testId: "leave" }),
  );

  const endBox = el("div", "join");
  endBox.dataset["testid"] = "ended-panel";
  const endTitle = el("h1", "legend");
  endBox.append(
    endTitle,
    rocker("join another room", () => window.location.reload(), { testId: "again" }),
  );

  const errorLine = el("p", "error");
  errorLine.dataset["testid"] = "error";
  errorLine.setAttribute("role", "alert");

  function counter(label: string): Counter {
    const node = el("span", "counter", `${label} `);
    const value = el("b");
    value.dataset["testid"] = `counter-${label}`;
    node.append(value);
    return { node, value };
  }

  function labelled(
    text: string,
    testId: string,
    placeholder: string,
  ): { label: HTMLLabelElement; input: HTMLInputElement } {
    const label = el("label");
    label.append(el("span", "legend", text));
    const input = el("input");
    input.placeholder = placeholder;
    input.dataset["testid"] = `input-${testId}`;
    input.autocomplete = "off";
    label.append(input);
    return { label, input };
  }

  // ---- screens ----
  /** Only the bands a screen uses are in the document, so no testid exists twice. */
  function mount(screen: UiModel["screen"]): void {
    if (screen === "room") root.replaceChildren(tallyBar, stage, rack, strip, tape);
    else if (screen === "waiting") root.replaceChildren(tallyBar, panelBand, tape);
    else root.replaceChildren(tallyBar, panelBand);
    if (screen !== "room") {
      for (const [pid, tile] of tiles) removeTile(pid, tile);
      // The feeds go with the tiles. Clearing frameLoops is what stops a loop (its next tick
      // sees a foreign symbol); left alone, the closures would keep the detached <video>s.
      feedOwner.clear();
      feedTracks.clear();
      frameCounts.clear();
      frameLoops.clear();
    }
    tapeDirty = true;
    shownScreen = screen;
  }

  function renderTallyBar(model: UiModel): void {
    const inRoom = model.screen === "room";
    const isHost = model.view.role === "host" || model.view.role === "cohost";
    let lampOn = "";
    let statusText = "the gallery";
    if (model.screen === "room") {
      lampOn = model.status === "joined" ? "tally" : "amber";
      // "reconnecting" covers the whole way back once we have been on air (the reconnecting
      // status and the hello that follows it); the first connect reads "connecting".
      const wasOnAir = model.sinceMs !== null;
      statusText =
        model.status === "joined"
          ? "on air"
          : model.status === "reconnecting" || wasOnAir
            ? "reconnecting"
            : "connecting";
    } else if (model.screen === "waiting") {
      lampOn = "amber";
      statusText = "waiting for the host";
    } else if (model.screen === "ended" || model.screen === "closed") {
      statusText = "off air";
    }
    setData(airLamp, "on", lampOn);
    setText(airStatus, statusText);
    const clock = inRoom && model.status === "joined" && model.sinceMs !== null;
    airClock.hidden = !clock;
    if (clock) setText(airClock, fmtClock(model.sinceMs ?? 0));
    for (const c of Object.values(counters)) c.node.hidden = !inRoom;
    setText(counters.room.value, model.roomCode);
    setText(counters.epoch.value, String(model.view.epoch));
    setText(counters.seq.value, String(model.view.seq));
    const locked = model.view.meta?.locked ?? false;
    lockButton.hidden = !(inRoom && isHost);
    endButton.hidden = !(inRoom && isHost);
    setText(lockButton, locked ? "unlock room" : "lock room");
    setPressed(lockButton, locked);
  }

  function renderPanel(model: UiModel): void {
    if (model.screen === "room") return;
    const box = model.screen === "join" ? joinForm : model.screen === "waiting" ? waitBox : endBox;
    if (panelBand.firstElementChild !== box || panelBand.childElementCount !== 1) {
      panelBand.replaceChildren(box);
      if (box === joinForm) code.input.focus();
    }
    if (box === joinForm) joinButton.disabled = false;
    if (box === endBox) {
      // A close with a reason (removed, denied, replaced) reads "Off air" over that reason;
      // only a chosen leave, which has none, reads "You left the room".
      const title =
        model.screen === "ended"
          ? "This room has ended"
          : model.error
            ? "Off air"
            : "You left the room";
      setText(endTitle, title);
    }
    if (model.error) {
      setText(errorLine, model.error);
      // The error sits above the box's button, which stays last.
      if (errorLine.parentElement !== box) box.insertBefore(errorLine, box.lastElementChild);
    } else {
      errorLine.remove();
    }
  }

  // ---- stage ----
  function tileFor(participantId: string, mirror: boolean): Tile {
    const existing = tiles.get(participantId);
    if (existing) return existing;
    const rootEl = el("article", "monitor");
    rootEl.dataset["testid"] = `tile-${participantId}`;
    rootEl.dataset["mirror"] = String(mirror);
    const picture = el("div", "picture");
    const video = el("video");
    video.autoplay = true;
    video.playsInline = true;
    video.muted = mirror;
    const stream = new MediaStream();
    video.srcObject = stream;
    const offNotice = el("div", "off-notice legend");
    const offLamp = el("span", "lamp");
    offLamp.dataset["on"] = "amber";
    const offText = el("span", undefined, "camera off");
    offNotice.append(offLamp, offText);
    offNotice.hidden = true;
    // The tally lamp comes last so it paints over the notice.
    const lamp = el("span", "lamp");
    picture.append(video, offNotice, lamp);
    const legend = el("div", "legend-strip legend");
    const nameEl = el("span", "name");
    const badges = el("span", "badges");
    legend.append(nameEl, badges);
    const meterEl = el("div", "meter");
    meterEl.setAttribute("aria-hidden", "true");
    const meter: HTMLElement[] = [];
    for (let i = 0; i < METER_SEGMENTS; i++) {
      const seg = el("i");
      meterEl.append(seg);
      meter.push(seg);
    }
    rootEl.append(picture, legend, meterEl);
    const tile: Tile = {
      root: rootEl,
      picture,
      video,
      stream,
      lamp,
      offNotice,
      offText,
      name: nameEl,
      badges,
      meter,
      reaction: null,
    };
    tiles.set(participantId, tile);
    return tile;
  }

  function removeTile(participantId: string, tile: Tile): void {
    tile.root.remove();
    tile.video.srcObject = null;
    tiles.delete(participantId);
  }

  function trackVideoFrames(trackId: string, video: HTMLVideoElement): void {
    const loop = Symbol(trackId);
    frameLoops.set(trackId, loop);
    frameCounts.set(trackId, 0);
    const tick = () => {
      if (frameLoops.get(trackId) !== loop) return;
      frameCounts.set(trackId, (frameCounts.get(trackId) ?? 0) + 1);
      video.requestVideoFrameCallback(tick);
    };
    video.requestVideoFrameCallback(tick);
  }

  function renderTile(tile: Tile, entry: RosterEntry, model: UiModel, isLocal: boolean): void {
    const speaking = model.view.activeSpeakers.includes(entry.participant_id);
    setData(tile.root, "speaking", String(speaking));
    setData(tile.lamp, "on", speaking ? "tally" : entry.connected ? "" : "amber");
    // The lit lamp is the only carrier of "speaking"; a name on it keeps the state readable
    // without a live region announcing every turn of the conversation.
    if (tile.lamp.hasAttribute("aria-label") !== speaking) {
      if (speaking) {
        tile.lamp.setAttribute("role", "img");
        tile.lamp.setAttribute("aria-label", "speaking");
      } else {
        tile.lamp.removeAttribute("role");
        tile.lamp.removeAttribute("aria-label");
      }
    }
    setText(tile.name, isLocal ? `${entry.name} (you)` : entry.name);
    // Legend order from the design direction: name, role, source, then the state and the layer.
    const badges: Array<[string, string?]> = [];
    if (entry.role !== "attendee") badges.push([entry.role]);
    for (const source of publishedSources(model, entry.participant_id)) badges.push([source]);
    if (entry.hand) badges.push(["hand up", "amber"]);
    if (entry.muted) badges.push(["mic off", "amber"]);
    if (!entry.connected) badges.push(["reconnecting", "amber"]);
    const videoTrack = model.view.tracks.find(
      (t) => t.owner === entry.participant_id && t.kind === "video",
    );
    if (videoTrack && !isLocal && !videoTrack.paused) {
      // The layer the SFU delivers to this client; prefs travel through the setLayer action.
      // A paused camera shows its lamp instead of a layer.
      const delivered = model.view.layers[videoTrack.track_id];
      badges.push([`L${delivered ?? videoTrack.layers}`]);
    }
    const wanted = badges.map(([text, tone]) => `${text}|${tone ?? ""}`).join(",");
    if (tile.badges.dataset["wanted"] !== wanted) {
      tile.badges.dataset["wanted"] = wanted;
      tile.badges.replaceChildren(
        ...badges.map(([text, tone]) => {
          const b = el("span", "badge", text);
          if (tone) b.dataset["tone"] = tone;
          return b;
        }),
      );
    }
    const hasCamera = isLocal
      ? !localCaptured || localTracks.video !== null
      : videoTrack !== undefined;
    const cameraOff = isLocal ? model.localState.videoOff : (videoTrack?.paused ?? true);
    tile.offNotice.hidden = hasCamera && !cameraOff;
    setText(tile.offText, hasCamera ? "camera off" : "no camera");
    const level = model.levels[isLocal ? LOCAL : entry.participant_id] ?? 0;
    const lit = Math.round(level * METER_SEGMENTS);
    tile.meter.forEach((seg, i) => setData(seg, "lit", String(i < lit)));
    const reaction = model.view.reactions.filter((r) => r.from === entry.participant_id).at(-1);
    if (reaction && (!tile.reaction || tile.reaction.dataset["until"] !== String(reaction.until))) {
      tile.reaction?.remove();
      const bubble = el("span", "reaction", reaction.emoji);
      bubble.dataset["until"] = String(reaction.until);
      tile.picture.append(bubble);
      tile.reaction = bubble;
    } else if (!reaction && tile.reaction) {
      tile.reaction.remove();
      tile.reaction = null;
    }
  }

  function renderStage(model: UiModel): void {
    if (model.screen !== "room") return;
    const me = model.view.participantId;
    const seen = new Set<string>();
    for (const entry of model.view.roster) {
      const isLocal = entry.participant_id === me;
      const tile = tileFor(entry.participant_id, isLocal);
      if (isLocal && localTracks.video && tile.stream.getVideoTracks().length === 0) {
        tile.stream.addTrack(localTracks.video);
        tile.video.srcObject = tile.stream;
      }
      renderTile(tile, entry, model, isLocal);
      seen.add(entry.participant_id);
      if (!tile.root.isConnected) {
        // Remote monitors fill the wall in arrival order; the local monitor stays last.
        const local = me === null ? undefined : tiles.get(me)?.root;
        if (!isLocal && local?.isConnected) stage.insertBefore(tile.root, local);
        else stage.append(tile.root);
      }
    }
    for (const [pid, tile] of tiles) if (!seen.has(pid)) removeTile(pid, tile);
  }

  // ---- rack ----
  function waiterRow(participantId: string): WaiterRow {
    const li = el("li");
    li.dataset["testid"] = `waiter-${participantId}`;
    const nameEl = el("span", "name");
    li.append(
      nameEl,
      rocker("let in", () => actions.admit(participantId), {
        small: true,
        testId: `admit-${participantId}`,
      }),
      rocker("not now", () => actions.deny(participantId), {
        small: true,
        tone: "amber",
        testId: `deny-${participantId}`,
      }),
    );
    return { li, name: nameEl };
  }

  function rosterRow(participantId: string): RosterRow {
    const li = el("li");
    li.dataset["testid"] = `roster-${participantId}`;
    const nameEl = el("span", "name");
    const flags = el("span", "badge legend");
    const controls = el("span", "controls");
    li.append(nameEl, flags, controls);
    return { li, name: nameEl, flags, controls, controlsFor: "" };
  }

  function renderGreenRoom(model: UiModel): void {
    setText(greenTitle, `Green room (${model.view.lobby.length})`);
    const seen = new Set<string>();
    for (const waiter of model.view.lobby) {
      let row = waiterRows.get(waiter.participant_id);
      if (!row) {
        row = waiterRow(waiter.participant_id);
        waiterRows.set(waiter.participant_id, row);
      }
      setText(row.name, waiter.name);
      seen.add(waiter.participant_id);
      if (!row.li.isConnected) greenList.append(row.li);
    }
    for (const [pid, row] of waiterRows) {
      if (!seen.has(pid)) {
        row.li.remove();
        waiterRows.delete(pid);
      }
    }
    greenEmpty.hidden = model.view.lobby.length > 0;
  }

  function renderRoster(model: UiModel, isHost: boolean): void {
    setText(rosterTitle, `In the room (${model.view.roster.length})`);
    const seen = new Set<string>();
    for (const entry of model.view.roster) {
      const pid = entry.participant_id;
      let row = rosterRows.get(pid);
      if (!row) {
        row = rosterRow(pid);
        rosterRows.set(pid, row);
      }
      setText(row.name, entry.name);
      // Type does the labelling here; the lamps live on the tally bar and the monitors.
      const flags: string[] = [];
      if (entry.role !== "attendee") flags.push(entry.role);
      if (entry.muted) flags.push("mic off");
      if (entry.hand) flags.push("hand up");
      if (!entry.connected) flags.push("reconnecting");
      setText(row.flags, flags.join(", "));
      const controlsFor =
        isHost && pid !== model.view.participantId && entry.role === "attendee" ? "host" : "";
      if (row.controlsFor !== controlsFor) {
        row.controlsFor = controlsFor;
        row.controls.replaceChildren();
        if (controlsFor === "host") {
          row.controls.append(
            rocker("mute", () => actions.mute(pid), { small: true, testId: `mute-${pid}` }),
            rocker("remove", () => actions.remove(pid), { small: true, testId: `remove-${pid}` }),
          );
        }
      }
      seen.add(pid);
      if (!row.li.isConnected) rosterList.append(row.li);
    }
    for (const [pid, row] of rosterRows) {
      if (!seen.has(pid)) {
        row.li.remove();
        rosterRows.delete(pid);
      }
    }
  }

  function renderTalk(model: UiModel): void {
    if (model.view.chat === renderedChat && model.view.roster === renderedNames) return;
    const grew = renderedChat === null || model.view.chat.length > renderedChat.length;
    renderedChat = model.view.chat;
    renderedNames = model.view.roster;
    const names = new Map(model.view.roster.map((r) => [r.participant_id, r.name]));
    chatLines.replaceChildren(
      ...model.view.chat.map((line) => {
        const p = el("div");
        const from = names.get(line.from) ?? "someone";
        const to = line.to ? ` to ${names.get(line.to) ?? "someone"}` : "";
        p.append(el("span", "who legend", `${from}${to}`), document.createTextNode(line.body));
        return p;
      }),
    );
    if (grew) chatLines.scrollTop = chatLines.scrollHeight;
  }

  function renderRack(model: UiModel): void {
    if (model.screen !== "room") return;
    const isHost = model.view.role === "host" || model.view.role === "cohost";
    greenModule.hidden = !isHost;
    if (isHost) renderGreenRoom(model);
    renderRoster(model, isHost);
    renderTalk(model);
  }

  // ---- control strip ----
  function renderStrip(model: UiModel): void {
    if (model.screen !== "room") return;
    const me = model.view.roster.find((r) => r.participant_id === model.view.participantId);
    setText(micButton, model.localState.muted ? "mic off" : "mic on");
    setPressed(micButton, !model.localState.muted);
    setText(cameraButton, model.localState.videoOff ? "camera off" : "camera on");
    setPressed(cameraButton, !model.localState.videoOff);
    setText(handButton, me?.hand ? "lower hand" : "raise hand");
    setPressed(handButton, me?.hand ?? false);
  }

  // ---- tape ----
  function renderTape(): void {
    if (!tapeDirty || !tape.isConnected) return;
    tapeDirty = false;
    tape.replaceChildren(
      ...tapeItems.map((item) => {
        const span = el("span");
        span.append(el("b", undefined, String(item.seq)), document.createTextNode(item.text));
        return span;
      }),
    );
  }

  return {
    render(model) {
      lastModel = model;
      root.dataset["screen"] = model.screen;
      if (model.screen !== shownScreen) mount(model.screen);
      renderTallyBar(model);
      renderPanel(model);
      renderStage(model);
      renderRack(model);
      renderStrip(model);
      renderTape();
    },
    attachFeed(trackId, kind, track) {
      const owner = lastModel?.view.tracks.find((t) => t.track_id === trackId)?.owner;
      if (!owner) return;
      feedOwner.set(trackId, owner);
      feedTracks.set(trackId, track);
      const tile = tileFor(owner, false);
      for (const old of tile.stream.getTracks())
        if (old.kind === kind) tile.stream.removeTrack(old);
      tile.stream.addTrack(track);
      tile.video.srcObject = tile.stream;
      if (kind === "video") trackVideoFrames(trackId, tile.video);
    },
    detachFeed(trackId) {
      const owner = feedOwner.get(trackId);
      const track = feedTracks.get(trackId);
      feedOwner.delete(trackId);
      feedTracks.delete(trackId);
      frameCounts.delete(trackId);
      frameLoops.delete(trackId);
      const tile = owner ? tiles.get(owner) : undefined;
      if (tile && track && tile.stream.getTracks().includes(track)) tile.stream.removeTrack(track);
    },
    attachLocal(tracks) {
      localTracks = tracks;
      localCaptured = true;
    },
    frames(trackId) {
      return frameCounts.get(trackId) ?? 0;
    },
    tape(seq, text) {
      tapeItems.unshift({ seq, text: text.trim() });
      if (tapeItems.length > TAPE_KEEP) tapeItems.pop();
      tapeDirty = true;
    },
  };
}
