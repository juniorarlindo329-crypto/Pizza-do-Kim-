const VERSION = "pizza-do-kim-vendedor-v1";
self.addEventListener("install", event => { self.skipWaiting(); });
self.addEventListener("activate", event => { event.waitUntil(self.clients.claim()); });
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith("/api/")) { event.respondWith(fetch(event.request)); return; }
  event.respondWith(fetch(event.request).catch(() => new Response(
    "Sem conexão com a internet. Tente novamente quando a conexão voltar.",
    {status:503, headers:{"Content-Type":"text/plain; charset=utf-8"}}
  )));
});
