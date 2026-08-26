const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DB = path.join(ROOT, "orders.json");

function readOrders() {
  try { return JSON.parse(fs.readFileSync(DB, "utf8")); }
  catch { return []; }
}
function saveOrders(orders) {
  fs.writeFileSync(DB, JSON.stringify(orders, null, 2), "utf8");
}
function send(res, code, data, type="application/json; charset=utf-8") {
  res.writeHead(code, {"Content-Type":type, "Cache-Control":"no-store"});
  res.end(type.startsWith("application/json") ? JSON.stringify(data) : data);
}
function bodyJson(req) {
  return new Promise((resolve,reject)=>{
    let data="";
    req.on("data",c=>{
      data+=c;
      if(data.length>1_000_000){ reject(new Error("too large")); req.destroy(); }
    });
    req.on("end",()=>{
      try{ resolve(JSON.parse(data||"{}")); }catch(e){ reject(e); }
    });
    req.on("error",reject);
  });
}
function sanitizeOrder(body) {
  const items = Array.isArray(body.items) ? body.items.slice(0,50).map(i=>({
    title:String(i.title||"Item").slice(0,100),
    detail:String(i.detail||"").slice(0,300),
    obs:String(i.obs||"").slice(0,300),
    qty:Math.max(1,Math.min(50,Number(i.qty)||1)),
    unit:Math.max(0,Number(i.unit)||0)
  })) : [];
  const subtotal=items.reduce((s,i)=>s+i.qty*i.unit,0);
  const deliveryFee=Math.max(0,Number(body.deliveryFee)||0);
  return {
    customer:{
      name:String(body.customer?.name||"").slice(0,100),
      phone:String(body.customer?.phone||"").slice(0,40),
      address:String(body.customer?.address||"").slice(0,220),
      reference:String(body.customer?.reference||"").slice(0,180),
      payment:String(body.customer?.payment||"").slice(0,80),
      change:String(body.customer?.change||"").slice(0,80)
    },
    items, subtotal, deliveryFee, total:subtotal+deliveryFee
  };
}

const server=http.createServer(async(req,res)=>{
  const u=new URL(req.url,`http://${req.headers.host}`);
  const pathname=u.pathname;

  if(pathname==="/api/orders" && req.method==="GET"){
    return send(res,200,readOrders());
  }

  if(pathname==="/api/orders" && req.method==="POST"){
    try{
      const body=sanitizeOrder(await bodyJson(req));
      if(!body.items.length) return send(res,400,{error:"Pedido vazio"});
      if(!body.customer.name || !body.customer.phone || !body.customer.address){
        return send(res,400,{error:"Dados do cliente incompletos"});
      }
      const orders=readOrders();
      const order={
        id:crypto.randomUUID(),
        number:String(Date.now()).slice(-6),
        createdAt:new Date().toISOString(),
        status:"new",
        ...body
      };
      orders.push(order);
      saveOrders(orders);
      return send(res,201,order);
    }catch(e){ return send(res,400,{error:"Pedido inválido"}); }
  }

  const match=pathname.match(/^\/api\/orders\/([^/]+)$/);
  if(match && req.method==="PATCH"){
    try{
      const body=await bodyJson(req);
      const orders=readOrders();
      const o=orders.find(x=>x.id===match[1]);
      if(!o) return send(res,404,{error:"Não encontrado"});
      if(body.status==="new" || body.status==="done") o.status=body.status;
      saveOrders(orders);
      return send(res,200,o);
    }catch(e){ return send(res,400,{error:"Inválido"}); }
  }

  if(match && req.method==="DELETE"){
    const orders=readOrders();
    const next=orders.filter(x=>x.id!==match[1]);
    saveOrders(next);
    return send(res,200,{ok:true});
  }

  let filePath;
  if(pathname==="/" || pathname==="/cliente") filePath=path.join(ROOT,"pizza_do_kim_site.html");
  else if(pathname==="/vendedor") filePath=path.join(ROOT,"pizza_do_kim_vendedor.html");
  else filePath=path.join(ROOT,pathname.replace(/^\/+/,""));

  if(!filePath.startsWith(ROOT)) return send(res,403,"Proibido","text/plain; charset=utf-8");

  fs.readFile(filePath,(err,data)=>{
    if(err) return send(res,404,"Não encontrado","text/plain; charset=utf-8");
    const ext=path.extname(filePath);
    const types={".html":"text/html; charset=utf-8",".js":"application/javascript; charset=utf-8",".json":"application/json; charset=utf-8",".css":"text/css; charset=utf-8"};
    send(res,200,data,types[ext]||"application/octet-stream");
  });
});

server.listen(PORT,()=>{
  console.log(`Pizza do Kim rodando em http://localhost:${PORT}`);
  console.log(`Cliente:  http://localhost:${PORT}/cliente`);
  console.log(`Vendedor: http://localhost:${PORT}/vendedor`);
});