// ==UserScript==
// @name         ChainWatch Saver Widget
// @namespace    chainwatch.epicmafia
// @version      1.0.0
// @description  Shows the current & next chain saver (and timer) from ChainWatch, inside Torn.
// @author       EPIC Mafia
// @match        https://www.torn.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      torn-epicmafia-saves.vercel.app
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const SITE = "https://torn-epicmafia-saves.vercel.app";
  const POLL_MS = 12000;

  // ── token (one-time setup) ───────────────────────────────────────────────
  let token = GM_getValue("cw_token", "");
  if (!token) {
    token = (prompt("ChainWatch: paste your saver-widget token (from the Admin page)") || "").trim();
    if (token) GM_setValue("cw_token", token);
  }
  GM_registerMenuCommand("Set ChainWatch token", function () {
    const t = (prompt("Paste your ChainWatch widget token:", GM_getValue("cw_token", "")) || "").trim();
    GM_setValue("cw_token", t);
    location.reload();
  });

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
  });
  box.innerHTML = '<div id="cw-body">ChainWatch…</div>';
  document.body.appendChild(box);

  // drag to reposition (persisted) — put it under Torn's chain timer once
  let drag = null;
  box.addEventListener("mousedown", function (e) {
    if (e.target.tagName === "A") return;
    drag = { x: e.clientX - box.offsetLeft, y: e.clientY - box.offsetTop };
    box.style.cursor = "grabbing";
  });
  window.addEventListener("mousemove", function (e) {
    if (!drag) return;
    box.style.left = Math.max(0, e.clientX - drag.x) + "px";
    box.style.top = Math.max(0, e.clientY - drag.y) + "px";
  });
  window.addEventListener("mouseup", function () {
    if (!drag) return;
    drag = null;
    box.style.cursor = "grab";
    GM_setValue("cw_pos", { top: box.offsetTop, left: box.offsetLeft });
  });

  // ── state + rendering ────────────────────────────────────────────────────
  let data = null;
  let fetchedAt = 0;
  let badToken = false;

  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec));
    return Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0");
  }

  function render() {
    const body = document.getElementById("cw-body");
    if (!body) return;
    const link = SITE + "/duty";

    if (badToken) {
      body.innerHTML =
        '<b style="color:#f87171">Bad token</b><br><span style="color:#a3a3a3">Tampermonkey ▸ menu ▸ Set token</span>';
      return;
    }
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
    if (!token) {
      badToken = true;
      render();
      return;
    }
    GM_xmlhttpRequest({
      method: "GET",
      url: SITE + "/api/widget?token=" + encodeURIComponent(token) + "&t=" + Date.now(),
      timeout: 10000,
      onload: function (r) {
        try {
          const j = JSON.parse(r.responseText);
          if (j.error) {
            badToken = true;
          } else {
            badToken = false;
            data = j;
            fetchedAt = Date.now();
          }
        } catch (e) {
          /* leave last data */
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
