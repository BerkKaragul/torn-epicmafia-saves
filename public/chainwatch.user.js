// ==UserScript==
// @name         ChainWatch Saver Widget
// @namespace    chainwatch.epicmafia
// @version      1.10.0
// @description  Shows the current & next chain saver (and timer) from ChainWatch, inside Torn — with the same danger siren as the site (one tab plays, not all).
// @author       EPIC Mafia
// @license      MIT
// @match        https://www.torn.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// @connect      torn-epicmafia-saves.vercel.app
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  // No setup needed — it just works. Data is faction-scoped and read-only
  // (saver names + chain timer only).
  const SITE = "https://torn-epicmafia-saves.vercel.app";
  // Adaptive cadence: relaxed while the chain is healthy, tight in the danger
  // window so a landed save clears the siren within seconds (war = seconds).
  const POLL_CALM_MS = 7000;
  const POLL_DANGER_MS = 3000;
  // Hide the whole widget for small/no chains — only chains worth saving (≥10)
  // are shown. Doubles as the "get it off my screen when nothing's happening"
  // ask, so no separate close button is needed.
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
  // Armed tabs elect a single "audio master" over a BroadcastChannel: a visible
  // tab beats a hidden one, ties broken by the oldest tab. Electing only among
  // *armed* tabs guarantees the master's audio is unlocked (arming = a click).
  const TAB_ID = Date.now() + "-" + Math.random();
  const peers = {}; // other armed tabs -> { t: lastBeat ms, vis: 0 visible / 1 hidden }
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
      if (p.vis < myV) return false; // a visible armed tab outranks this hidden one
      if (p.vis === myV && olderThan(id, TAB_ID)) return false; // same visibility, older wins
    }
    return true;
  }
  function announce(type) {
    if (bc) bc.postMessage({ type: type, id: TAB_ID, vis: myVis() });
  }
  if (bc) {
    bc.onmessage = function (e) {
      const m = e.data || {};
      if (m.type === "beat" && m.id) peers[m.id] = { t: Date.now(), vis: m.vis || 0 };
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
    if (sirenTimer) clearInterval(sirenTimer);
    sirenTimer = null;
    sirenLevel = null;
  }

  function updateSiren(live, danger, critical) {
    if (!sirenOn || !live || !danger) {
      stopSiren();
      return;
    }
    if (sirenTimer && sirenLevel === critical) return; // already running at right cadence
    stopSiren();
    sirenLevel = critical;
    burst(critical);
    sirenTimer = setInterval(function () {
      burst(critical);
    }, alarmInterval(critical));
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
  // Persistent header (title + siren toggle) so a re-render never wipes the
  // button; only #cw-body is rewritten each poll.
  box.innerHTML =
    '<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">' +
    '<b style="color:#34d399;font-size:11px;flex:1">🔗 ChainWatch</b>' +
    '<span id="cw-siren" data-cw-nodrag="1" style="cursor:pointer;font-size:15px;line-height:1" ' +
    'title="Arm danger siren">' +
    (sirenOn ? "🔊" : "🔇") +
    "</span></div>" +
    '<input id="cw-vol" data-cw-nodrag="1" type="range" min="0" max="100" ' +
    'title="Siren volume" ' +
    'style="width:100%;height:12px;margin:0 0 6px;accent-color:#10b981;cursor:pointer;display:block">' +
    '<label data-cw-nodrag="1" style="display:flex;align-items:center;gap:4px;font-size:10px;' +
    'color:#a3a3a3;margin-bottom:4px;cursor:pointer">' +
    '<input id="cw-onlyduty" type="checkbox" style="accent-color:#10b981;cursor:pointer">' +
    'only alarm when I&#39;m saving</label>' +
    '<input id="cw-myname" data-cw-nodrag="1" type="text" placeholder="your exact Torn name" ' +
    'style="display:none;width:100%;box-sizing:border-box;margin:0 0 6px;padding:2px 5px;' +
    'font-size:10px;background:#171717;border:1px solid #404040;border-radius:5px;color:#e5e5e5">' +
    '<div id="cw-body">ChainWatch…</div>';
  document.body.appendChild(box);

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
    const maxL = Math.max(0, window.innerWidth - box.offsetWidth);
    const maxT = Math.max(0, window.innerHeight - box.offsetHeight);
    box.style.left = Math.min(box.offsetLeft, maxL) + "px";
    box.style.top = Math.min(box.offsetTop, maxT) + "px";
  }
  clamp();
  window.addEventListener("resize", clamp);

  // drag to reposition (persisted). Pointer Events + pointer-capture is the
  // one approach that reliably works in mobile webviews like TornPDA; touch/
  // mouse events there often never reach the script. Fall back to touch/mouse
  // only if PointerEvent is missing.
  let drag = null;

  function noDrag(target) {
    return target.tagName === "A" || (target.closest && target.closest("[data-cw-nodrag]"));
  }

  function moveTo(px, py) {
    const maxL = Math.max(0, window.innerWidth - box.offsetWidth);
    const maxT = Math.max(0, window.innerHeight - box.offsetHeight);
    box.style.left = Math.min(Math.max(0, px - drag.x), maxL) + "px";
    box.style.top = Math.min(Math.max(0, py - drag.y), maxT) + "px";
  }
  function persist() {
    drag = null;
    box.style.cursor = "grab";
    GM_setValue("cw_pos", { top: box.offsetTop, left: box.offsetLeft });
  }

  if (window.PointerEvent) {
    box.addEventListener("pointerdown", function (e) {
      if (noDrag(e.target)) return; // let the link / siren button be tapped
      drag = { x: e.clientX - box.offsetLeft, y: e.clientY - box.offsetTop, id: e.pointerId };
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
      persist();
    };
    box.addEventListener("pointerup", up);
    box.addEventListener("pointercancel", up);
  } else {
    const pt = (e) => (e.touches && e.touches[0] ? e.touches[0] : e);
    const start = function (e) {
      if (noDrag(e.target)) return;
      const p = pt(e);
      drag = { x: p.x - box.offsetLeft, y: p.y - box.offsetTop };
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
  // outdated install without anyone touching the server.
  const MY_VERSION =
    (typeof GM_info !== "undefined" && GM_info.script && GM_info.script.version) || "1.9.0";
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
    const body = document.getElementById("cw-body");
    if (!body) return;
    const link = SITE + "/duty";

    if (!data) {
      updateSiren(false, false, false);
      box.style.display = "none";
      return;
    }

    // outdated → gentle nudge; below the server's floor → stop and demand update
    const outdated = data.latest_version && cmpVersion(MY_VERSION, data.latest_version) < 0;
    if (data.min_version && cmpVersion(MY_VERSION, data.min_version) < 0) {
      updateSiren(false, false, false);
      box.style.display = "";
      body.innerHTML =
        '<div style="color:#f87171;font-weight:700">⚠ Update required</div>' +
        '<a href="' +
        INSTALL_URL +
        '" target="_blank" style="color:#34d399;font-weight:700;text-decoration:underline">Update the widget →</a>';
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

    // scary like the site: glow the box red while the chain is in danger
    if (danger) {
      box.style.borderColor = critical ? "#ef4444" : "#f59e0b";
      box.style.boxShadow = "0 0 14px " + (critical ? "rgba(239,68,68,.7)" : "rgba(245,158,11,.55)");
    } else {
      box.style.borderColor = "#10b981";
      box.style.boxShadow = "0 4px 14px rgba(0,0,0,.5)";
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

    body.innerHTML = html;
  }

  function poll() {
    GM_xmlhttpRequest({
      method: "GET",
      url: SITE + "/api/widget?t=" + Date.now(),
      timeout: 10000,
      onload: function (r) {
        syncClock(r.responseHeaders);
        try {
          const j = JSON.parse(r.responseText);
          if (!j.error) data = j;
        } catch (e) {
          /* keep showing last known data */
        }
        render();
      },
      onerror: function () {
        /* keep showing last known data */
      },
    });
  }

  // poll faster while the chain is in the danger window, slower when it's safe
  function currentPollMs() {
    if (data && data.chain) {
      const c = data.chain;
      const live = c.id > 0 && c.current > 0 && c.cooldown_s === 0;
      if (live) {
        const remaining = c.observed_at
          ? Math.max(0, c.timeout_s - (nowS() - c.observed_at))
          : c.timeout_s;
        if (remaining <= (data.alert_threshold_s || 90)) return POLL_DANGER_MS;
      }
    }
    return POLL_CALM_MS;
  }
  let pollTimer = null;
  function scheduleNextPoll() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(function () {
      poll();
      scheduleNextPoll();
    }, currentPollMs());
  }

  render(); // apply the hide-when-small rule immediately (no first-paint flash)
  poll();
  scheduleNextPoll();
  setInterval(render, 1000); // smooth countdown + siren check between polls
})();
