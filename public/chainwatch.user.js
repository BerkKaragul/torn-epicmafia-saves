// ==UserScript==
// @name         ChainWatch Saver Widget
// @namespace    chainwatch.epicmafia
// @version      1.4.0
// @description  Shows the current & next chain saver (and timer) from ChainWatch, inside Torn — with the same danger siren as the site.
// @author       EPIC Mafia
// @license      MIT
// @match        https://www.torn.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      torn-epicmafia-saves.vercel.app
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  // No setup needed — it just works. Data is faction-scoped and read-only
  // (saver names + chain timer only).
  const SITE = "https://torn-epicmafia-saves.vercel.app";
  const POLL_MS = 12000;

  // ── danger siren ─────────────────────────────────────────────────────────
  // A verbatim port of the website's alarm (lib/alarm.ts): a harsh sawtooth
  // air-raid siren sweeping through a dissonant partner tone, chopped by a
  // fast tremolo. `critical` (chain about to die) is faster, higher and louder.
  let audioCtx = null;

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

    const master = c.createGain();
    master.gain.setValueAtTime(0, t0);
    master.gain.linearRampToValueAtTime(critical ? 0.6 : 0.42, t0 + 0.02);
    master.gain.setValueAtTime(critical ? 0.6 : 0.42, t0 + dur - 0.08);
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
    playAlarm(critical);
    sirenTimer = setInterval(function () {
      playAlarm(critical);
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
    '<div id="cw-body">ChainWatch…</div>';
  document.body.appendChild(box);

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
      playAlarm(false); // a test blast so you know it's live
    } else {
      stopSiren();
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

  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec));
    return Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0");
  }

  function render() {
    const body = document.getElementById("cw-body");
    if (!body) return;
    const link = SITE + "/duty";

    if (!data) {
      body.textContent = "ChainWatch…";
      updateSiren(false, false, false);
      return;
    }

    const c = data.chain;
    const live = c.id > 0 && c.current > 0 && c.cooldown_s === 0;
    // extrapolate from when the poller last observed the timer
    const elapsed = c.observed_at ? Math.floor(Date.now() / 1000) - c.observed_at : 0;
    const remaining = live ? Math.max(0, c.timeout_s - elapsed) : 0;
    const danger = live && remaining <= (data.alert_threshold_s || 90);
    const critical = live && remaining <= 45;
    const timerColor = critical ? "#f87171" : danger ? "#fbbf24" : "#34d399";

    // scary like the site: glow the box red while the chain is in danger
    if (danger) {
      box.style.borderColor = critical ? "#ef4444" : "#f59e0b";
      box.style.boxShadow = "0 0 14px " + (critical ? "rgba(239,68,68,.7)" : "rgba(245,158,11,.55)");
    } else {
      box.style.borderColor = "#10b981";
      box.style.boxShadow = "0 4px 14px rgba(0,0,0,.5)";
    }

    // keep the audible alarm in lockstep with the site's logic
    updateSiren(live, danger, critical);

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
        "</div>";
      if (data.next)
        html += '<div style="color:#a3a3a3">next: ' + data.next + "</div>";
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
    body.innerHTML = html;
  }

  function poll() {
    GM_xmlhttpRequest({
      method: "GET",
      url: SITE + "/api/widget?t=" + Date.now(),
      timeout: 10000,
      onload: function (r) {
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

  poll();
  setInterval(poll, POLL_MS);
  setInterval(render, 1000); // smooth countdown + siren check between polls
})();
