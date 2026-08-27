const CACHE_VERSION="pizza-do-kim-pwa-v3";

self.addEventListener("install",event=>{
  self.skipWaiting();
});

self.addEventListener("activate",event=>{
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch",event=>{
  const url=new URL(event.request.url);

  // Pedidos e login nunca usam cache.
  if(url.pathname.startsWith("/api/") || url.pathname==="/login" || url.pathname==="/logout"){
    event.respondWith(fetch(event.request));
    return;
  }

  // Conteúdo visual sempre tenta buscar a versão mais nova.
  event.respondWith(
    fetch(event.request).catch(()=>new Response(
      "Sem conexão com a internet. Tente novamente quando a conexão voltar.",
      {status:503,headers:{"Content-Type":"text/plain; charset=utf-8"}}
    ))
  );
});
