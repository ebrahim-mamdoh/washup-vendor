/*
 * Carzen panels — background notifications (Firebase Cloud Messaging, web push).
 *
 * The server sends data-only messages ({ id, type, title, body, href, app }).
 * When a panel tab is visible it gets the message and shows a toast; otherwise
 * this worker shows a system notification. Clicking it focuses the panel and
 * opens the notification's page.
 */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    return;
  }
  // FCM wraps data messages as { data: {...}, from, fcmMessageId, ... }.
  const data = payload.data || payload;
  if (!data || !data.title) return;

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      windows.forEach((client) => client.postMessage({ type: "carzen-push", data }));
      if (windows.some((client) => client.visibilityState === "visible")) return;
      await self.registration.showNotification(data.title, {
        body: data.body || "",
        tag: data.id,
        dir: "rtl",
        lang: "ar",
        icon: "/logo.svg",
        data: { href: data.href || "/notifications" },
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const href = (event.notification.data && event.notification.data.href) || "/notifications";
  const url = new URL(href, self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = windows.find((client) => client.url.startsWith(self.location.origin));
      if (open) {
        await open.focus();
        return open.navigate(url);
      }
      return self.clients.openWindow(url);
    })(),
  );
});
