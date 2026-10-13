self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  const data = e.data ? e.data.json() : {};
  e.waitUntil(
    self.registration.showNotification(data.title || "Match ready!", {
      body: data.body || "",
      tag: "match-ready",
      renotify: true,
      requireInteraction: true,
      icon: "/icon.svg",
      data: { id: data.id },
      // Action buttons show on Android/desktop; iOS only supports tapping the notification.
      actions: [{ action: "accept", title: "Accept (press Enter)" }],
    })
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const id = e.notification.data && e.notification.data.id;

  if (e.action === "accept" && id) {
    e.waitUntil(
      fetch("/api/press", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      })
    );
    return;
  }

  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) if ("focus" in c) return c.focus();
      return self.clients.openWindow("/");
    })
  );
});
