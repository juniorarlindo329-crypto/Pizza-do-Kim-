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


self.addEventListener("push",event=>{
  let data={};
  try{ data=event.data ? event.data.json() : {}; }catch(e){}
  const title=data.title || "Pizza do Kim 🍕";
  const options={
    body:data.body || "Seu pedido foi atualizado.",
    icon:data.icon || "/icon-192.png",
    badge:data.badge || "/icon-192.png",
    tag:data.orderId ? `pedido-${data.orderId}` : "pizza-do-kim",
    renotify:true,
    data:{url:data.url || "/cliente"}
  };
  event.waitUntil(self.registration.showNotification(title,options));
});

self.addEventListener("notificationclick",event=>{
  event.notification.close();
  const url=event.notification.data?.url || "/cliente";
  event.waitUntil(
    clients.matchAll({type:"window",includeUncontrolled:true}).then(list=>{
      for(const client of list){
        if("focus" in client){
          client.navigate(url);
          return client.focus();
        }
      }
      return clients.openWindow ? clients.openWindow(url) : null;
    })
  );
});
