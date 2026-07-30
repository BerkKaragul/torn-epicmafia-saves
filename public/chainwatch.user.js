// ==UserScript==
// @name         ChainWatch Saver Widget
// @namespace    chainwatch.epicmafia
// @version      1.3.0
// @description  Shows the current & next chain saver (and timer) from ChainWatch, inside Torn.
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
  box.innerHTML = '<div id="cw-body">ChainWatch…</div>';
  document.body.appendChild(box);

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
      if (e.target.tagName === "A") return; // let the link be tapped
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
      if (e.target.tagName === "A") return;
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

    let html = '<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">';
    html += '<b style="color:#34d399;font-size:11px">🔗 ChainWatch</b></div>';

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
  setInterval(render, 1000); // smooth countdown between polls
})();
