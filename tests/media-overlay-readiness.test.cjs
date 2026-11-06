const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

// Isolate the real playback method from the reader's DOM-heavy imports.
const source = fs.readFileSync(path.join(__dirname,
  "../src/modules/mediaoverlays/MediaOverlayModule.ts"), "utf8");
const parsed = ts.createSourceFile("module.ts", source, ts.ScriptTarget.Latest, true);
const readerClass = parsed.statements.find(ts.isClassDeclaration);
const method = readerClass.members.find(member => member.name?.getText(parsed) === "playMediaOverlaysAudio");
const compiled = ts.transpileModule(`class Playback { ${method.getText(parsed)} }`, {
  compilerOptions: { target: ts.ScriptTarget.ES2020 }
}).outputText;

function fixture() {
  const errors = [];
  class Audio extends EventTarget {
    paused = true;
    currentTime = 0;
    readyState = 0;
    plays = 0;
    rejectPlay = false;
    setAttribute(name, value) { this[name] = value; }
    pause() { this.paused = true; }
    async play() {
      this.plays++;
      if (this.rejectPlay) throw new Error("Playback blocked");
      this.paused = false;
    }
  }
  const audio = new Audio();
  let attached = false;
  const document = {
    getElementById: () => attached ? audio : null,
    createElement: () => audio,
    body: { appendChild: () => { attached = true; } }
  };
  const Playback = new Function("document", "log", `${compiled}; return Playback;`)(
    document, { log() {}, error(...args) { errors.push(args); } }
  );
  const reader = new Playback();
  Object.assign(reader, {
    settings: { playing: true, resourceReady: true, rate: 1, volume: 1, wait: 0 },
    getBeginEndFromNode: () => ({ begin: undefined, end: undefined }),
    getUrlNoQuery: pair => pair.Audio,
    ensureOnTimeUpdate() {}
  });
  return { reader, audio, errors };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 20));

test("successive short clips start on canplay without canplaythrough", async () => {
  const { reader, audio } = fixture();
  for (const url of ["heading.mp3", "segment-2.mp3", "segment-3.mp3"]) {
    const previousPlays = audio.plays;
    await reader.playMediaOverlaysAudio({ Audio: url }, undefined, undefined, true);
    assert.equal(audio.src, url);
    assert.equal(audio.paused, true);
    audio.readyState = 3; // HAVE_FUTURE_DATA, not HAVE_ENOUGH_DATA (4).
    audio.dispatchEvent(new Event("canplay"));
    await flush();
    assert.equal(audio.paused, false);
    assert.equal(audio.plays, previousPlays + 1);
    // Buffering/repeated readiness events must not restart the clip.
    audio.dispatchEvent(new Event("canplay"));
    audio.dispatchEvent(new Event("canplaythrough"));
    await flush();
    assert.equal(audio.plays, previousPlays + 1);
  }
});

test("switching files removes a pending readiness listener", async () => {
  const { reader, audio } = fixture();
  await reader.playMediaOverlaysAudio({ Audio: "old.mp3" });
  await reader.playMediaOverlaysAudio({ Audio: "new.mp3" });
  audio.dispatchEvent(new Event("canplay"));
  await flush();
  assert.equal(audio.plays, 1);
  assert.equal(audio.src, "new.mp3");
});

test("a rejected play call is logged instead of becoming an unhandled rejection", async () => {
  const { reader, audio, errors } = fixture();
  audio.rejectPlay = true;
  await reader.playMediaOverlaysAudio({ Audio: "blocked.mp3" });
  audio.dispatchEvent(new Event("canplay"));
  await flush();
  assert.equal(errors.length, 1);
  assert.equal(errors[0][1], "blocked.mp3");
  assert.match(errors[0][2].message, /Playback blocked/);
});
