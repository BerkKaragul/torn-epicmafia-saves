// ==UserScript==
// @name         ChainWatch Saver Widget
// @namespace    chainwatch.epicmafia
// @version      1.15.3
// @description  Shows the current & next chain saver (and timer) from ChainWatch, inside Torn — with the same danger siren as the site (one tab plays, not all).
// @author       EPIC Mafia
// @license      MIT
// @match        https://www.torn.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// @grant        GM_registerMenuCommand
// @connect      cw.cloum.com
// @connect      torn-epicmafia-saves.vercel.app
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  // No setup needed — it just works. Data is faction-scoped and read-only
  // (saver names + chain timer only).
  const SITE = "https://torn-epicmafia-saves.vercel.app";
  // The live feed is read straight from the ChainWatch server (a public,
  // read-only RPC), not through the site: polling the site cost a Vercel
  // function call per poll. It moved off Supabase in 1.15.0 when the free
  // plan's traffic quota ran out, and from sslip.io to our own name behind
  // Cloudflare in 1.15.2. The anon key is public by design — every table is
  // locked behind RLS and this one function is all it can reach.
  const FEED_URL = "https://cw.cloum.com/rest/v1/rpc/widget_feed";
  const FEED_KEY =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6ImNoYWlud2F0Y2giLCJpYXQiOjE3OTIzMjA5MjIsImV4cCI6MjQyMzA0MDkyMn0.qnKJI-EMIUiipNseJHLK1EhnPb4HYu5YB6Kx2KJ_TUc";
  // Adaptive cadence: relaxed while the chain is healthy, tight in the danger
  // window so a landed save clears the siren within seconds (war = seconds),
  // and slow while there's no chain worth showing. The server refreshes the
  // chain every ~10s and the countdown runs locally; on our own server traffic
  // is free, so the widget picks up each refresh within a few seconds.
  const POLL_IDLE_MS = 60000;
  const POLL_CALM_MS = 5000;
  const POLL_DANGER_MS = 3000;
  // Fallback road for networks that block the backend's hostname (a Romanian
  // ISP blocked sslip.io, 1.15.0's): the same feed, proxied by the site's own address,
  // which every member can reach. It runs on Vercel's quota, so it keeps
  // 1.14.0's pace, and the direct road is retried every few minutes.
  const FALLBACK_URL = SITE + "/feed";
  const FALLBACK_CALM_MS = 15000;
  const FALLBACK_DANGER_MS = 5000;
  const DIRECT_RETRY_MS = 10 * 60 * 1000;
  // Hide the whole widget for small/no chains — only chains worth saving (≥10)
  // are shown, so it's off the screen when nothing's happening.
  const HIDE_BELOW_CHAIN = 10;

  // ── danger siren ─────────────────────────────────────────────────────────
  // A verbatim port of the website's alarm (lib/alarm.ts): a harsh sawtooth
  // air-raid siren sweeping through a dissonant partner tone, chopped by a
  // fast tremolo. `critical` (chain about to die) is faster, higher and louder.
  let audioCtx = null;
  let sirenVol = GM_getValue("cw_vol", 1); // per-device siren loudness, 0–1
  let onlyDuty = GM_getValue("cw_onlyduty", false); // only alarm when it's my turn
  let myName = GM_getValue("cw_myname", ""); // my Torn name, matched to the turn-holder

  function audio() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") audioCtx.resume();
      return audioCtx;
    } catch (e) {
      return null;
    }
  }

  // Call once from a click (arm) so the browser lets us make noise later.
  function armAlarm() {
    const c = audio();
    if (!c) return false;
    const osc = c.createOscillator();
    const gain = c.createGain();
    gain.gain.value = 0.0001;
    osc.connect(gain).connect(c.destination);
    osc.start();
    osc.stop(c.currentTime + 0.01);
    return true;
  }

  function playAlarm(critical) {
    const c = audio();
    if (!c) return;
    const t0 = c.currentTime;
    const dur = critical ? 1.5 : 1.1;
    const sweeps = critical ? 3 : 2;
    const lowHz = critical ? 620 : 440;
    const highHz = critical ? 1750 : 1150;

    const peak = (critical ? 0.6 : 0.42) * sirenVol;
    const master = c.createGain();
    master.gain.setValueAtTime(0, t0);
    master.gain.linearRampToValueAtTime(peak, t0 + 0.02);
    master.gain.setValueAtTime(peak, t0 + dur - 0.08);
    master.gain.linearRampToValueAtTime(0, t0 + dur);

    // tremolo: chops the tone so it pulses rather than drones
    const tremolo = c.createGain();
    tremolo.gain.value = 1;
    const lfo = c.createOscillator();
    const lfoDepth = c.createGain();
    lfo.type = "square";
    lfo.frequency.value = critical ? 14 : 9;
    lfoDepth.gain.value = 0.5;
    lfo.connect(lfoDepth).connect(tremolo.gain);

    // a touch of distortion for grit
    const shaper = c.createWaveShaper();
    const curve = new Float32Array(257);
    for (let i = 0; i < 257; i++) {
      const x = (i / 256) * 2 - 1;
      curve[i] = Math.tanh(x * 3);
    }
    shaper.curve = curve;

    tremolo.connect(shaper).connect(master).connect(c.destination);

    const makeVoice = function (type, detune, level) {
      const osc = c.createOscillator();
      const g = c.createGain();
      osc.type = type;
      osc.detune.value = detune;
      g.gain.value = level;
      const step = dur / (sweeps * 2);
      osc.frequency.setValueAtTime(lowHz, t0);
      for (let i = 0; i < sweeps; i++) {
        const base = t0 + i * step * 2;
        osc.frequency.linearRampToValueAtTime(highHz, base + step);
        osc.frequency.linearRampToValueAtTime(lowHz, base + step * 2);
      }
      osc.connect(g).connect(tremolo);
      osc.start(t0);
      osc.stop(t0 + dur);
    };

    makeVoice("sawtooth", 0, 0.5);
    makeVoice("square", 30, 0.28); // dissonant partner = harsher, more "wrong"
    if (critical) makeVoice("sawtooth", -1200, 0.22); // octave-down growl

    lfo.start(t0);
    lfo.stop(t0 + dur);

    // phones: buzz in the same rhythm
    try {
      if (navigator.vibrate) navigator.vibrate(critical ? [300, 90, 300, 90, 600] : [220, 120, 220]);
    } catch (e) {
      /* unsupported */
    }
  }

  function alarmInterval(critical) {
    return critical ? 1700 : 2600;
  }

  // siren loop — mirrors the site: while armed AND the chain is in danger,
  // burst on a timer; re-time the interval when danger escalates to critical.
  let sirenOn = GM_getValue("cw_siren", false);
  let sirenTimer = null;
  let sirenLevel = null; // null = stopped, false = warning cadence, true = critical

  // ── cross-tab audio master ─────────────────────────────────────────────────
  // With several Torn tabs open, every tab would blast the siren at once. Only
  // ONE tab should make the sound (the visual widget still runs in all of them).
  // Tabs elect a single "audio master" over a BroadcastChannel: a visible tab
  // beats a hidden one, ties broken by the oldest tab. Only tabs that are
  // actually sounding take part — a tab that's muted ("only on my turn"),
  // disarmed, retired, or whose audio the browser blocked must never win,
  // or nobody plays at all. Old (pre-1.11.1) tabs don't send `on`, so they
  // never win either.
  const TAB_ID = Date.now() + "-" + Math.random();
  const peers = {}; // other tabs -> { t: lastBeat ms, vis: 0 visible / 1 hidden, on: sounding }
  let bc = null;
  try {
    if (window.BroadcastChannel) bc = new BroadcastChannel("cw_siren_audio");
  } catch (e) {
    /* fall back to solo playback */
  }

  const myVis = () => (document.hidden ? 1 : 0);
  function olderThan(a, b) {
    const na = parseInt(a, 10);
    const nb = parseInt(b, 10);
    return na !== nb ? na < nb : a < b; // lower timestamp = older tab wins
  }
  function isAudioMaster() {
    if (!sirenOn) return false;
    if (!bc) return true; // no cross-tab support → this tab just plays
    const now = Date.now();
    const myV = myVis();
    for (const id in peers) {
      const p = peers[id];
      if (now - p.t > 3000) {
        delete peers[id]; // stale — that tab is gone or throttled
        continue;
      }
      if (!p.on) continue; // not sounding — can't stand in for us
      if (p.vis < myV) return false; // a visible armed tab outranks this hidden one
      if (p.vis === myV && olderThan(id, TAB_ID)) return false; // same visibility, older wins
    }
    return true;
  }
  // sounding = siren running here, and the browser hasn't blocked our audio
  // (a context still suspended after a burst means no user gesture yet)
  const sounding = () => !!sirenTimer && (!audioCtx || audioCtx.state === "running");
  function announce(type) {
    if (bc) bc.postMessage({ type: type, id: TAB_ID, vis: myVis(), on: sounding() });
  }
  if (bc) {
    bc.onmessage = function (e) {
      const m = e.data || {};
      if (m.type === "beat" && m.id) peers[m.id] = { t: Date.now(), vis: m.vis || 0, on: !!m.on };
      else if (m.type === "bye" && m.id) delete peers[m.id];
    };
    setInterval(() => announce("beat"), 1000); // heartbeat so others can rank us
    document.addEventListener("visibilitychange", () => announce("beat")); // re-rank on tab switch
    window.addEventListener("pagehide", () => announce("bye")); // hand off promptly on close
  }

  function burst(critical) {
    if (isAudioMaster()) playAlarm(critical); // only the elected tab makes noise
  }

  function stopSiren() {
    if (!sirenTimer) return;
    clearInterval(sirenTimer);
    sirenTimer = null;
    sirenLevel = null;
    announce("beat"); // tell the others at once so one of them can take over
  }

  function updateSiren(live, danger, critical) {
    if (!sirenOn || !live || !danger) {
      stopSiren();
      return;
    }
    if (sirenTimer && sirenLevel === critical) return; // already running at right cadence
    stopSiren();
    sirenLevel = critical;
    sirenTimer = setInterval(function () {
      burst(critical);
    }, alarmInterval(critical));
    announce("beat"); // claim the sound before the first burst
    burst(critical);
  }

  // ── widget element ───────────────────────────────────────────────────────
  const box = document.createElement("div");
  const pos = GM_getValue("cw_pos", { top: 120, left: 8 });
  Object.assign(box.style, {
    position: "fixed",
    top: pos.top + "px",
    left: pos.left + "px",
    zIndex: 99999,
    width: "168px",
    padding: "8px 10px",
    background: "#0a0a0a",
    border: "1px solid #10b981",
    borderRadius: "10px",
    color: "#e5e5e5",
    font: "12px/1.35 system-ui, sans-serif",
    boxShadow: "0 4px 14px rgba(0,0,0,.5)",
    cursor: "grab",
    userSelect: "none",
    touchAction: "none", // let us handle touch-drag instead of the page scrolling
  });
  // Persistent header (title + siren toggle + minimize/close) so a re-render
  // never wipes the buttons; only #cw-body is rewritten each poll. Minimized,
  // the header alone stays, with the countdown (#cw-mini) beside the title.
  // The buttons never shrink and the title clips instead, so the countdown
  // appearing can't push them out of a narrow sidebar.
  const HDR_BTN =
    'data-cw-nodrag="1" style="flex:none;width:10px;text-align:center;cursor:pointer;font-size:14px;' +
    'line-height:1;color:#737373"';
  box.innerHTML =
    '<div id="cw-head" style="display:flex;align-items:center;gap:4px;margin-bottom:4px">' +
    '<b style="color:#34d399;font-size:11px;flex:1;min-width:0;overflow:hidden;white-space:nowrap">' +
    '🔗<span id="cw-title"> ChainWatch</span> ' +
    '<span id="cw-mini" style="display:none;font-variant-numeric:tabular-nums"></span>' +
    '<span id="cw-who" style="display:none;color:#a3a3a3;font-weight:400"></span></b>' +
    '<span id="cw-siren" data-cw-nodrag="1" style="flex:none;cursor:pointer;font-size:15px;line-height:1" ' +
    'title="Arm danger siren">' +
    (sirenOn ? "🔊" : "🔇") +
    "</span>" +
    '<span id="cw-minbtn" ' + HDR_BTN + ">–</span>" +
    '<span id="cw-pop" ' + HDR_BTN + ' title="Pop out (float and drag it)">⤢</span>' +
    '<span id="cw-close" ' + HDR_BTN + ">×</span>" +
    "</div>" +
    '<div id="cw-full">' +
    '<input id="cw-vol" data-cw-nodrag="1" type="range" min="0" max="100" ' +
    'title="Siren volume" ' +
    'style="width:100%;height:12px;margin:0 0 6px;accent-color:#10b981;cursor:pointer;display:block">' +
    '<label data-cw-nodrag="1" style="display:flex;align-items:center;gap:4px;font-size:10px;' +
    'color:#a3a3a3;margin-bottom:4px;cursor:pointer">' +
    '<input id="cw-onlyduty" type="checkbox" style="accent-color:#10b981;cursor:pointer">' +
    'only alarm on my turn</label>' +
    '<input id="cw-myname" data-cw-nodrag="1" type="text" placeholder="your exact Torn name" ' +
    'style="display:none;width:100%;box-sizing:border-box;margin:0 0 6px;padding:2px 5px;' +
    'font-size:10px;background:#171717;border:1px solid #404040;border-radius:5px;color:#e5e5e5">' +
    '<div id="cw-body">ChainWatch…</div>' +
    "</div>";
  document.body.appendChild(box);

  // ── layout: docked / floating / pill ─────────────────────────────────────
  // On desktop Torn the widget sits inside the sidebar, under the bars, as part
  // of the page; on mobile Torn (TornPDA too) the sidebar is a header strip of
  // bars, and the widget becomes one more full-width row under it. Wherever
  // neither is on screen (Information block collapsed, a layout we don't know)
  // it floats and can be dragged instead. Some prefer the old floating widget:
  // ⤢ pops it out of the sidebar, and × on the floating one puts it back.
  // With nowhere to dock, × shrinks it to a small tab that a tap brings back.
  // It never disappears outright: 1.12.0 hid it for the whole chain, and
  // TornPDA has no userscript menu to bring it back, so a closed widget stayed
  // lost for days.
  // Minimize, pop-out and pill live in GM storage so every tab follows
  // (syncSettings). The siren keeps following its own toggle either way.
  let minimized = GM_getValue("cw_min", false);
  let pill = GM_getValue("cw_pill", false);
  let poppedOut = GM_getValue("cw_float", false);
  let docked = null; // null = floating, else "desktop" / "mobile"
  let dockable = false; // a sidebar/header slot is on screen (docked or not)
  const fullEl = box.querySelector("#cw-full");
  const headEl = box.querySelector("#cw-head");
  const miniEl = box.querySelector("#cw-mini");
  const whoEl = box.querySelector("#cw-who");
  const titleEl = box.querySelector("#cw-title");
  const minBtn = box.querySelector("#cw-minbtn");
  const closeBtn = box.querySelector("#cw-close");
  const popBtn = box.querySelector("#cw-pop");
  // docked: the widget plus a divider styled like Torn's own, so it reads as
  // one more section of the sidebar
  const dock = document.createElement("div");
  const dockHr = document.createElement("hr");
  dock.appendChild(dockHr);

  function applyLayout() {
    const asPill = pill && !dockable; // with a slot on screen, × means "dock it"
    const folded = minimized || asPill;
    const strip = docked === "mobile"; // a full-width row has room to spare
    fullEl.style.display = folded ? "none" : "";
    headEl.style.marginBottom = folded ? "0" : "4px";
    miniEl.style.display = folded ? "" : "none";
    // minimized in the strip, the turn-holder rides along with the countdown
    whoEl.style.display = folded && strip ? "" : "none";
    // the countdown takes the name's place where space is tight
    titleEl.style.display = asPill || (minimized && !strip) ? "none" : "";
    box.querySelector("#cw-siren").style.display = asPill ? "none" : "";
    minBtn.style.display = asPill ? "none" : "";
    closeBtn.style.display = docked || asPill ? "none" : ""; // nothing to shrink in the sidebar
    closeBtn.title = dockable ? "Put it back in the sidebar" : "Shrink to a small tab";
    popBtn.style.display = docked ? "" : "none";
    minBtn.textContent = minimized ? "+" : "–";
    minBtn.title = minimized ? "Expand" : "Minimize";
    box.title = asPill ? "Tap to open ChainWatch" : "";
    if (docked) {
      Object.assign(box.style, {
        position: "relative", // in the page flow; anchors the version tag
        top: "", // the floating position would shift a relative box
        left: "",
        fontFamily: "inherit", // Torn's own font, like the rows around it
        width: "auto",
        padding: strip ? "6px 10px" : "5px 6px",
        margin: strip ? "0" : "4px 0 8px",
        background: strip ? "#333" : "transparent",
        borderRadius: strip ? "0" : "5px",
        cursor: "default",
        userSelect: "",
        touchAction: "",
      });
    } else {
      Object.assign(box.style, {
        position: "fixed",
        fontFamily: "system-ui, sans-serif",
        width: asPill ? "auto" : "168px",
        padding: asPill ? "4px 9px" : "8px 10px",
        margin: "0",
        background: "#0a0a0a",
        borderRadius: asPill ? "14px" : "10px",
        cursor: "grab",
        userSelect: "none",
        touchAction: "none", // let us handle touch-drag instead of the page scrolling
      });
    }
  }

  // Where to dock, from Torn's bars (energy … chain) if they're on screen.
  // Any bar will do: the chain bar alone isn't a link while you're flying, and
  // 1.14.0 only looked for the link, so travellers got a floating widget.
  // Class names carry a build hash (bar-mobile___hjfT3), so match on the
  // stable prefixes.
  //   desktop: bar < bars < sidebar block; we go at the block's end, after
  //            the bars (and TornTools' OC/RW lines, if any)
  //   mobile:  bar < bars row < user-info rows < header; we go right under
  //            the user-info rows, as a row of the header
  // One member's TornPDA (iPhone) shows the bars yet never matched them, so
  // a phone-width page that has Torn's sidebar root but no recognisable bars
  // docks at the end of that root — right under the header rows. dockDiag
  // records how the slot was found (shown faint beside the version tag when
  // it isn't the normal way): m/v = bars matched/visible, then r = docked via
  // the root fallback, x = a bar we couldn't classify, p = parents missing,
  // n = nowhere to dock.
  let dockDiag = "";
  function sidebarSlot() {
    const all = Array.from(
      document.querySelectorAll('[class*="bar-desktop___"], [class*="bar-mobile___"]'),
    );
    const visible = all.filter((el) => el.getClientRects().length);
    const counts = "m" + all.length + "v" + visible.length;
    const bar = visible[0];
    const cls = bar ? bar.getAttribute("class") || "" : ""; // a string even on SVG
    let why = "n";
    if (bar && bar.parentElement) {
      const bars = bar.parentElement;
      const rows = bars.parentElement;
      if (/bar-desktop/.test(cls) && rows) {
        dockDiag = "";
        return { mode: "desktop", parent: rows, after: null };
      }
      if (/bar-mobile/.test(cls) && rows && rows.parentElement) {
        dockDiag = "";
        return { mode: "mobile", parent: rows.parentElement, after: rows };
      }
      why = /bar-(desktop|mobile)/.test(cls) ? "p" : "x";
    }
    const root = document.getElementById("sidebarroot");
    if (window.innerWidth < 1000 && root && root.getClientRects().length) {
      dockDiag = counts + why + "r";
      return { mode: "mobile", parent: root, after: null };
    }
    dockDiag = counts + why;
    return null;
  }

  // Runs every tick: Torn re-renders the sidebar on its own and may drop us or
  // only appear after we start, and a resize can move between layouts.
  function place() {
    const slot = sidebarSlot();
    if (!!slot !== dockable) {
      dockable = !!slot;
      applyLayout();
    }
    if (slot && !poppedOut) {
      if (dock.parentElement !== slot.parent) {
        const hr = slot.parent.querySelector('hr[class*="delimiter___"]');
        dockHr.className = hr ? hr.className : "";
        dockHr.style.display = slot.mode === "desktop" ? "" : "none"; // the strip has its own edge
        if (slot.after) slot.after.after(dock);
        else slot.parent.appendChild(dock);
      }
      if (box.parentElement !== dock) dock.appendChild(box);
      if (docked !== slot.mode) {
        docked = slot.mode;
        applyLayout();
      }
    } else {
      if (box.parentElement !== document.body) {
        dock.remove();
        document.body.appendChild(box);
      }
      if (docked) {
        docked = null;
        const p = GM_getValue("cw_pos", { top: 120, left: 8 });
        box.style.top = p.top + "px";
        box.style.left = p.left + "px";
        applyLayout();
        clamp();
      }
    }
    dock.style.display = box.style.display; // the divider goes with the widget
  }
  applyLayout();

  minBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    minimized = !minimized;
    GM_setValue("cw_min", minimized);
    applyLayout();
  });
  function setPill(on) {
    pill = on;
    GM_setValue("cw_pill", on);
    applyLayout();
    clamp();
  }
  function setPoppedOut(on) {
    poppedOut = on;
    GM_setValue("cw_float", on);
    place();
  }
  popBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    setPoppedOut(true);
  });
  closeBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    if (dockable) setPoppedOut(false);
    else setPill(true);
  });
  if (typeof GM_registerMenuCommand === "function") {
    GM_registerMenuCommand("Show ChainWatch widget", function () {
      minimized = false;
      GM_setValue("cw_min", false);
      setPill(false);
    });
  }

  // siren volume slider — persisted per device; preview a blast on release
  const volSlider = box.querySelector("#cw-vol");
  volSlider.value = Math.round(sirenVol * 100);
  volSlider.addEventListener("input", function () {
    sirenVol = Math.min(1, Math.max(0, Number(this.value) / 100));
    GM_setValue("cw_vol", sirenVol);
  });
  volSlider.addEventListener("change", function () {
    if (sirenVol > 0) {
      armAlarm();
      playAlarm(false);
    }
  });

  // "only alarm when I'm saving" — the widget is anonymous, so you enter your
  // Torn name once (the box appears only when the option is on) and we match it
  // against the on-duty roster from the feed
  const onlyDutyBox = box.querySelector("#cw-onlyduty");
  const myNameInput = box.querySelector("#cw-myname");
  onlyDutyBox.checked = onlyDuty;
  myNameInput.value = myName;
  myNameInput.style.display = onlyDuty ? "block" : "none";
  onlyDutyBox.addEventListener("change", function () {
    onlyDuty = this.checked;
    GM_setValue("cw_onlyduty", onlyDuty);
    myNameInput.style.display = onlyDuty ? "block" : "none";
  });
  myNameInput.addEventListener("input", function () {
    myName = this.value.trim();
    GM_setValue("cw_myname", myName);
  });

  // Settings live in GM storage, shared by every tab, but each tab read them
  // once at load — so a change made in one tab never reached the others
  // (including whichever tab was making the sound). Re-read them every tick.
  function syncSettings() {
    const armed = GM_getValue("cw_siren", false);
    if (armed !== sirenOn) {
      sirenOn = armed;
      sirenBtn.textContent = sirenOn ? "🔊" : "🔇";
      sirenBtn.title = sirenOn ? "Siren armed — tap to mute" : "Arm danger siren";
    }
    onlyDuty = GM_getValue("cw_onlyduty", false);
    if (onlyDutyBox.checked !== onlyDuty) {
      onlyDutyBox.checked = onlyDuty;
      myNameInput.style.display = onlyDuty ? "block" : "none";
    }
    if (document.activeElement !== myNameInput) {
      myName = GM_getValue("cw_myname", "");
      if (myNameInput.value !== myName) myNameInput.value = myName;
    }
    if (document.activeElement !== volSlider) {
      sirenVol = GM_getValue("cw_vol", 1);
      volSlider.value = Math.round(sirenVol * 100);
    }
    const min = GM_getValue("cw_min", false);
    const pl = GM_getValue("cw_pill", false);
    poppedOut = GM_getValue("cw_float", false); // place() picks it up this tick
    if (min !== minimized || pl !== pill) {
      minimized = min;
      pill = pl;
      applyLayout();
    }
  }

  // optional "I'm here" button (delegated — the body is re-rendered each poll):
  // copies a ready-to-paste "Saving #<chain> if needed" note to the clipboard
  box.addEventListener("click", function (e) {
    const btn = e.target.closest && e.target.closest("#cw-imhere");
    if (!btn) return;
    e.stopPropagation();
    const n = data && data.chain ? data.chain.current : 0;
    try {
      GM_setClipboard("Saving #" + n + " if needed");
      btn.innerHTML = "✅ Copied";
    } catch (err) {
      /* clipboard unavailable */
    }
  });

  // siren toggle — the click also unlocks audio (required on mobile/TornPDA)
  const sirenBtn = box.querySelector("#cw-siren");
  sirenBtn.title = sirenOn ? "Siren armed — tap to mute" : "Arm danger siren";
  sirenBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    sirenOn = !sirenOn;
    GM_setValue("cw_siren", sirenOn);
    sirenBtn.textContent = sirenOn ? "🔊" : "🔇";
    sirenBtn.title = sirenOn ? "Siren armed — tap to mute" : "Arm danger siren";
    if (sirenOn) {
      armAlarm(); // unlock audio for later bursts
      playAlarm(false); // a test blast so you know it's live (this tab)
      announce("beat"); // join the audio-master election right away
    } else {
      stopSiren();
      announce("bye"); // leave the election so another tab can take over
    }
  });

  // keep it on-screen (handy when switching between PC and mobile)
  function clamp() {
    if (docked) return;
    const maxL = Math.max(0, window.innerWidth - box.offsetWidth);
    const maxT = Math.max(0, window.innerHeight - box.offsetHeight);
    box.style.left = Math.min(box.offsetLeft, maxL) + "px";
    box.style.top = Math.min(box.offsetTop, maxT) + "px";
  }
  clamp();
  window.addEventListener("resize", function () {
    place();
    clamp();
  });

  // drag to reposition (persisted). Pointer Events + pointer-capture is the
  // one approach that reliably works in mobile webviews like TornPDA; touch/
  // mouse events there often never reach the script. Fall back to touch/mouse
  // only if PointerEvent is missing.
  let drag = null;

  function noDrag(target) {
    return target.tagName === "A" || (target.closest && target.closest("[data-cw-nodrag]"));
  }

  function moveTo(px, py) {
    // a few pixels of wobble is still a tap, not a drag
    if (Math.abs(px - drag.sx) + Math.abs(py - drag.sy) > 5) drag.moved = true;
    const maxL = Math.max(0, window.innerWidth - box.offsetWidth);
    const maxT = Math.max(0, window.innerHeight - box.offsetHeight);
    box.style.left = Math.min(Math.max(0, px - drag.x), maxL) + "px";
    box.style.top = Math.min(Math.max(0, py - drag.y), maxT) + "px";
  }
  function persist(e) {
    if (!drag) return;
    const tapped = !drag.moved && !(e && /cancel/.test(e.type));
    drag = null;
    box.style.cursor = "grab";
    if (tapped) {
      if (pill) setPill(false); // the pill opens on a tap
      return;
    }
    GM_setValue("cw_pos", { top: box.offsetTop, left: box.offsetLeft });
  }

  if (window.PointerEvent) {
    box.addEventListener("pointerdown", function (e) {
      if (docked || noDrag(e.target)) return; // let the link / siren button be tapped
      drag = {
        x: e.clientX - box.offsetLeft,
        y: e.clientY - box.offsetTop,
        sx: e.clientX,
        sy: e.clientY,
        id: e.pointerId,
      };
      try {
        box.setPointerCapture(e.pointerId); // route all further moves to the box
      } catch (_) {}
      box.style.cursor = "grabbing";
      e.preventDefault();
    });
    box.addEventListener("pointermove", function (e) {
      if (!drag || e.pointerId !== drag.id) return;
      moveTo(e.clientX, e.clientY);
      e.preventDefault();
    });
    const up = function (e) {
      if (!drag) return;
      try {
        box.releasePointerCapture(drag.id);
      } catch (_) {}
      persist(e);
    };
    box.addEventListener("pointerup", up);
    box.addEventListener("pointercancel", up);
  } else {
    const pt = (e) => (e.touches && e.touches[0] ? e.touches[0] : e);
    const start = function (e) {
      if (docked || noDrag(e.target)) return;
      const p = pt(e);
      drag = { x: p.x - box.offsetLeft, y: p.y - box.offsetTop, sx: p.x, sy: p.y };
      box.style.cursor = "grabbing";
    };
    const move = function (e) {
      if (!drag) return;
      const p = pt(e);
      moveTo(p.x, p.y);
      if (e.cancelable) e.preventDefault();
    };
    box.addEventListener("mousedown", start);
    box.addEventListener("touchstart", start, { passive: true });
    window.addEventListener("mousemove", move);
    window.addEventListener("touchmove", move, { passive: false });
    window.addEventListener("mouseup", persist);
    window.addEventListener("touchend", persist);
    window.addEventListener("touchcancel", persist);
  }

  // ── state + rendering ────────────────────────────────────────────────────
  let data = null;

  // Align the countdown to the SERVER clock, not this device's (which may be
  // minutes off). Refreshed from each response's Date header, so every member
  // — and the website — extrapolate from the same reference.
  let clockOffsetMs = 0;
  const nowMs = () => Date.now() + clockOffsetMs;
  const nowS = () => Math.floor(nowMs() / 1000);

  function syncClock(rawHeaders) {
    try {
      if (!rawHeaders) return;
      let dateMs = null;
      let age = 0;
      rawHeaders.split(/\r?\n/).forEach(function (line) {
        const i = line.indexOf(":");
        if (i < 0) return;
        const k = line.slice(0, i).trim().toLowerCase();
        const v = line.slice(i + 1).trim();
        if (k === "date") {
          const t = Date.parse(v);
          if (!isNaN(t)) dateMs = t;
        } else if (k === "age") {
          const a = parseInt(v, 10);
          if (!isNaN(a)) age = a;
        }
      });
      if (dateMs !== null) clockOffsetMs = dateMs + age * 1000 - Date.now();
    } catch (e) {
      /* leave the offset as-is */
    }
  }

  // ── self-update signalling ─────────────────────────────────────────────────
  // The server advertises the latest (and minimum-allowed) widget version; we
  // compare against our own so we can nudge — or, in an emergency, stop — an
  // outdated install without anyone touching the server. The fallback (for
  // hosts without GM_info) must match @version, or the floor locks it out.
  const MY_VERSION =
    (typeof GM_info !== "undefined" && GM_info.script && GM_info.script.version) || "1.15.3";
  // tucked into the bottom-right corner, faint and taking no space of its
  // own, so a screenshot tells which build runs
  const versionTag = () =>
    '<span style="position:absolute;right:5px;bottom:2px;font-size:8px;line-height:1;' +
    'color:#5c5c5c;pointer-events:none">v' +
    MY_VERSION +
    (dockDiag && !poppedOut ? " · " + dockDiag : "") +
    "</span>";
  const belowFloor = () => !!(data && data.min_version && cmpVersion(MY_VERSION, data.min_version) < 0);
  const INSTALL_URL = "https://greasyfork.org/en/scripts/589168-chainwatch-saver-widget";
  function cmpVersion(a, b) {
    const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
    const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d < 0 ? -1 : 1;
    }
    return 0;
  }

  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec));
    return Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0");
  }

  function render() {
    paint();
    place();
  }

  function paint() {
    const body = box.querySelector("#cw-body");
    if (!body) return;
    syncSettings();
    adoptNewer();
    const link = SITE + "/duty";

    // No fresh reading: never count down a frozen one. 1.15.0 kept painting
    // the last copy it had (for some, the final Supabase reading) when it
    // couldn't reach the server, so the timer sat at 0:00 — and could siren.
    // Say so instead, with the reason, and keep quiet.
    if (!data || Date.now() - dataAt > STALE_MS) {
      updateSiren(false, false, false);
      if (!lastError) {
        box.style.display = "none"; // nothing fetched yet, nothing wrong yet
        return;
      }
      box.style.display = "";
      box.style.borderColor = docked ? "#555" : "#10b981";
      box.style.boxShadow = docked ? "none" : "0 4px 14px rgba(0,0,0,.5)";
      miniEl.textContent = "offline";
      miniEl.style.color = "#a3a3a3";
      whoEl.textContent = "";
      body.innerHTML =
        '<div style="color:#fbbf24;font-weight:700">⚠ Can&#39;t reach ChainWatch</div>' +
        '<div style="color:#a3a3a3;font-size:10px">' +
        lastError +
        (data ? " · last update " + fmt((Date.now() - dataAt) / 1000) + " ago" : "") +
        "</div>" +
        versionTag();
      return;
    }

    // outdated → gentle nudge; below the server's floor → stop and demand update
    const outdated = data.latest_version && cmpVersion(MY_VERSION, data.latest_version) < 0;
    if (belowFloor()) {
      updateSiren(false, false, false);
      box.style.display = "";
      body.innerHTML =
        '<div style="color:#f87171;font-weight:700">⚠ Update required</div>' +
        '<a href="' +
        INSTALL_URL +
        '" target="_blank" style="color:#34d399;font-weight:700;text-decoration:underline">Update the widget →</a>' +
        versionTag();
      return;
    }

    const c = data.chain;
    // only real chains (≥10) are worth showing — hide otherwise, sound off too
    if (!c || c.current < HIDE_BELOW_CHAIN) {
      updateSiren(false, false, false);
      box.style.display = "none";
      return;
    }
    box.style.display = "";

    const live = c.id > 0 && c.current > 0 && c.cooldown_s === 0;
    // extrapolate from when the poller last observed the timer (server clock)
    const elapsed = c.observed_at ? nowS() - c.observed_at : 0;
    const remaining = live ? Math.max(0, c.timeout_s - elapsed) : 0;
    const danger = live && remaining <= (data.alert_threshold_s || 90);
    const critical = live && remaining <= Math.round((data.alert_threshold_s || 90) / 2);
    const timerColor = critical ? "#f87171" : danger ? "#fbbf24" : "#34d399";
    miniEl.textContent = live ? fmt(remaining) : c.cooldown_s > 0 ? "cooldown" : "";
    miniEl.style.color = timerColor;
    whoEl.textContent = !data.saving_enabled
      ? ""
      : data.on_duty > 0
        ? " · 🛡 " + (data.turn || "?") + (data.next ? " → " + data.next : "")
        : " · 🚨 no savers";

    // scary like the site: glow the box red while the chain is in danger
    if (danger) {
      box.style.borderColor = critical ? "#ef4444" : "#f59e0b";
      box.style.boxShadow = "0 0 14px " + (critical ? "rgba(239,68,68,.7)" : "rgba(245,158,11,.55)");
    } else {
      // docked, a quiet border like the rest of the sidebar; it still lights up
      box.style.borderColor = docked ? "#555" : "#10b981";
      box.style.boxShadow = docked ? "none" : "0 4px 14px rgba(0,0,0,.5)";
    }

    // "only when I'm saving" mutes the sound (not the visuals) unless it's
    // actually MY turn to save — i.e. I'm the current turn-holder, not merely
    // enlisted behind someone else. Matches the site. With no name set yet,
    // never mute (don't silently miss an alarm).
    const isMyTurn =
      !!myName && !!data.turn && data.turn.toLowerCase() === myName.toLowerCase();
    const sirenMuted = onlyDuty && !!myName && !isMyTurn;

    // keep the audible alarm in lockstep with the site's logic
    updateSiren(live, danger && !sirenMuted, critical);

    let html = "";
    if (live) {
      html +=
        '<div style="font-weight:800;font-size:20px;color:' +
        timerColor +
        ';font-variant-numeric:tabular-nums">' +
        fmt(remaining) +
        '</div><div style="color:#a3a3a3;font-size:11px;margin-bottom:4px">chain ' +
        c.current.toLocaleString() +
        (c.max ? " / " + c.max.toLocaleString() : "") +
        "</div>";
    } else {
      html +=
        '<div style="color:#a3a3a3;margin-bottom:4px">' +
        (c.cooldown_s > 0 ? "chain on cooldown" : "no chain") +
        "</div>";
    }

    if (!data.saving_enabled) {
      html += '<div style="color:#a3a3a3">Saving is off</div>';
    } else if (data.on_duty > 0) {
      html +=
        '<div style="color:#34d399;font-weight:700">🛡 ' +
        (data.turn || "?") +
        (data.turn_location
          ? ' <span style="color:#737373;font-weight:400;font-size:10px">📍' +
            data.turn_location +
            "</span>"
          : "") +
        "</div>";
      if (data.next)
        html +=
          '<div style="color:#a3a3a3">next: ' +
          data.next +
          (data.next_location
            ? ' <span style="color:#737373;font-size:10px">📍' + data.next_location + "</span>"
            : "") +
          "</div>";
      html +=
        '<div style="color:#737373;font-size:10px;margin-top:2px">' +
        data.on_duty +
        " on duty</div>";
    } else {
      html +=
        '<div style="color:#f87171;font-weight:800">🚨 NO SAVERS!</div>' +
        '<a href="' +
        link +
        '" target="_blank" style="color:#34d399;font-weight:700;text-decoration:underline">Go apply →</a>';
    }
    // optional "I'm here" note — only once the chain is getting close (≤1:30)
    if (live && remaining <= 90) {
      html +=
        '<button id="cw-imhere" data-cw-nodrag="1" ' +
        'title="Copy a ready-to-paste chat note" ' +
        'style="width:100%;margin-top:5px;padding:3px 6px;font:600 10px/1.2 system-ui;' +
        'color:#a3a3a3;background:transparent;border:1px dashed #404040;border-radius:6px;cursor:pointer">' +
        '👋 I&#39;m here <span style="opacity:.55">(optional)</span></button>';
    }

    if (outdated) {
      html +=
        '<a href="' +
        INSTALL_URL +
        '" target="_blank" style="display:block;margin-top:3px;color:#fbbf24;font-size:10px;text-decoration:underline">⬆ Update available</a>';
    }
    html += versionTag();

    body.innerHTML = html;
  }

  // ── one fetch per browser, not per tab ──────────────────────────────────
  // Every Torn page load and every open tab runs its own copy of this script,
  // and each used to poll on its own clock — a few tabs per member multiplied
  // the traffic. The last reading is shared through GM storage (common to all
  // tabs and page loads): a tab only fetches when nobody has within the
  // current cadence, otherwise it adopts the shared copy. A freshly loaded
  // page also paints from it at once instead of fetching.
  // Keyed by feed source: TornPDA gives every userscript one storage, so an
  // old copy left installed beside this one wrote Supabase's frozen reading
  // into "cw_feed" and 1.15.0 counted it down to 0:00.
  const SHARED_KEY = "cw_feed_vps"; // { at, data, off } — the last reading, and when
  const CLAIM_KEY = "cw_feed_vps_claim"; // ms when some tab started a fetch
  let dataAt = 0; // local ms when our current reading was fetched (by any tab)
  let lastError = ""; // why our last fetch failed, shown when we go stale
  // older than this and a reading isn't shown at all (the server refreshes the
  // chain every ~10s, so a minute without one means we've lost it)
  const STALE_MS = 60000;
  function adoptShared(maxAgeMs) {
    const sh = GM_getValue(SHARED_KEY, null);
    if (!sh || !sh.data || Date.now() - sh.at >= maxAgeMs) return false;
    data = sh.data;
    dataAt = sh.at;
    clockOffsetMs = sh.off || 0;
    return true;
  }
  // every tick: pick up a reading another tab fetched since ours, so tabs stay
  // in step with whichever one is doing the fetching
  function adoptNewer() {
    const sh = GM_getValue(SHARED_KEY, null);
    if (sh && sh.data && sh.at > dataAt) adoptShared(STALE_MS);
  }

  // since when this browser has been going round by the site, 0 = direct;
  // shared, so every tab takes the road that works
  const viaSite = () => Date.now() - GM_getValue("cw_via_site", 0) < DIRECT_RETRY_MS;

  function poll() {
    // a little slack so a tab whose timer lands just before the cadence is up
    // still adopts the copy instead of fetching again
    if (adoptShared(currentPollMs() - 1000) || Date.now() - GM_getValue(CLAIM_KEY, 0) < 3000) {
      render(); // fresh enough, or another tab's fetch is already in flight
      return;
    }
    GM_setValue(CLAIM_KEY, Date.now());
    fetchFeed(viaSite());
  }

  function fetchFeed(fallback) {
    // the direct road failing (blocked, or a block page that isn't our JSON)
    // sends this browser round by the site, at once
    const failed = function (why) {
      lastError = why;
      if (!fallback) {
        GM_setValue("cw_via_site", Date.now());
        fetchFeed(true);
        return;
      }
      render();
    };
    GM_xmlhttpRequest({
      method: "GET",
      url: fallback ? FALLBACK_URL : FEED_URL,
      headers: { apikey: FEED_KEY },
      timeout: 10000,
      onload: function (r) {
        let j = null;
        try {
          j = JSON.parse(r.responseText);
        } catch (e) {
          /* not our feed */
        }
        if (!j || !j.ok) return failed("server replied " + r.status);
        syncClock(r.responseHeaders);
        data = j;
        dataAt = Date.now();
        lastError = "";
        GM_setValue(SHARED_KEY, { at: dataAt, data: j, off: clockOffsetMs });
        render();
      },
      // keep showing last known data (while it's fresh), and remember why
      onerror: function () {
        failed("connection blocked or offline");
      },
      ontimeout: function () {
        failed("server timed out");
      },
    });
  }

  // poll faster while the chain is in the danger window, slower when it's
  // safe, and rarely when there's no chain worth showing (widget hidden)
  function currentPollMs() {
    if (belowFloor()) return POLL_IDLE_MS; // retired install: just watch for the floor to drop
    if (data && data.chain) {
      const c = data.chain;
      if (c.current < HIDE_BELOW_CHAIN) return POLL_IDLE_MS;
      const live = c.id > 0 && c.current > 0 && c.cooldown_s === 0;
      if (live) {
        const remaining = c.observed_at
          ? Math.max(0, c.timeout_s - (nowS() - c.observed_at))
          : c.timeout_s;
        if (remaining <= (data.alert_threshold_s || 90))
          return viaSite() ? FALLBACK_DANGER_MS : POLL_DANGER_MS;
      }
    }
    return viaSite() ? FALLBACK_CALM_MS : POLL_CALM_MS;
  }
  let pollTimer = null;
  function scheduleNextPoll() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(function () {
      poll();
      scheduleNextPoll();
    }, currentPollMs());
  }

  // Paint the last shared reading at once — but only a recent one. An old
  // reading extrapolates the timer to 0:00 and would blast a false siren for
  // the moment until the fresh fetch lands. While Torn is open some tab
  // refreshes it every ≤5s, so page-to-page navigation still paints instantly.
  adoptShared(POLL_CALM_MS);
  render(); // apply the hide-when-small rule immediately (no first-paint flash)
  poll();
  scheduleNextPoll();
  setInterval(render, 1000); // smooth countdown + siren check between polls
})();
