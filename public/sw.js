/* ChainWatch service worker: shows pushes and focuses/opens the right page. */

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    /* non-JSON push */
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "ChainWatch", {
      body: data.body || "",
      icon: "/icon.svg",
      badge: "/icon.svg",
      tag: data.type || "chainwatch",
      renotify: true,
      requireInteraction: data.type === "your_turn",
      vibrate: data.type === "your_turn" ? [200, 80, 200, 80, 400] : [150],
      data: { url: data.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data && event.notification.data.url ? event.notification.data.url : "/";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      const abs = new URL(url, self.location.origin).href;
      for (const c of list) {
        if (c.url === abs && "focus" in c) return c.focus();
      }
      return clients.openWindow(url);
    }),
  );
});
