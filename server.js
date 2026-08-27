const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const querystring = require("querystring");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DB = path.join(ROOT, "orders.json");

// Defina SELLER_PASSWORD no Render. Não coloque a senha no GitHub.
const SELLER_PASSWORD = process.env.SELLER_PASSWORD || "troque-esta-senha";
const SESSION_SECRET = process.env.SESSION_SECRET || "pizza-do-kim-session-secret";

function readOrders() {
  try { return JSON.parse(fs.readFileSync(DB, "utf8")); }
  catch { return []; }
}
function saveOrders(orders) {
  fs.writeFileSync(DB, JSON.stringify(orders, null, 2), "utf8");
}
function send(res, code, data, type="application/json; charset=utf-8", extraHeaders={}) {
  res.writeHead(code, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    ...extraHeaders
  });
  res.end(type.startsWith("application/json") ? JSON.stringify(data) : data);
}
function bodyText(req) {
  return new Promise((resolve,reject)=>{
    let data="";
    req.on("data",c=>{
      data+=c;
      if(data.length>1_000_000){ reject(new Error("too large")); req.destroy(); }
    });
    req.on("end",()=>resolve(data));
    req.on("error",reject);
  });
}
async function bodyJson(req) {
  return JSON.parse((await bodyText(req)) || "{}");
}
function getCookies(req) {
  const cookies={};
  const raw=req.headers.cookie || "";
  raw.split(";").forEach(part=>{
    const i=part.indexOf("=");
    if(i>0) cookies[part.slice(0,i).trim()]=decodeURIComponent(part.slice(i+1).trim());
  });
  return cookies;
}
function sellerToken() {
  return crypto.createHmac("sha256", SESSION_SECRET)
    .update("pizza-do-kim:" + SELLER_PASSWORD)
    .digest("hex");
}
function isLogged(req) {
  const value=getCookies(req).seller_session || "";
  const expected=sellerToken();
  const a=Buffer.from(value);
  const b=Buffer.from(expected);
  return a.length===b.length && crypto.timingSafeEqual(a,b);
}
function loginPage(error="") {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta name="theme-color" content="#a71919">
<title>Pizza do Kim - Login</title>
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:20px;font-family:Arial,Helvetica,sans-serif;background:#fff8ef;color:#211a18}
.card{width:min(100%,420px);background:#fff;border:1px solid #eaded6;border-radius:20px;padding:28px;box-shadow:0 12px 35px #4b221217}
.logo{width:88px;height:88px;border-radius:50%;display:block;margin:0 auto 16px;object-fit:cover;background:#a71919}
h1{text-align:center;color:#a71919;margin:0 0 8px;font-size:29px}
p{text-align:center;color:#716762;line-height:1.45;margin:0 0 20px}
label{display:block;font-weight:800;margin:10px 0 7px}
input{width:100%;min-height:52px;border:1px solid #d8ccc5;border-radius:12px;padding:12px 14px;font-size:18px}
button{width:100%;min-height:52px;border:0;border-radius:12px;background:#a71919;color:white;font-size:17px;font-weight:900;margin-top:14px;cursor:pointer}
.error{background:#fff0ef;color:#8d1212;border:1px solid #f0b7b2;border-radius:10px;padding:10px;margin-bottom:14px;font-weight:700;text-align:center}
small{display:block;text-align:center;color:#786e69;margin-top:15px}
</style>
</head>
<body>
<form class="card" method="POST" action="/login">
  <img class="logo" src="/icon-192.png" alt="Pizza do Kim">
  <h1>Pizza do Kim</h1>
  <p>Painel do vendedor<br>Entre para acessar e imprimir os pedidos.</p>
  ${error ? `<div class="error">${error}</div>` : ""}
  <label for="password">Senha</label>
  <input id="password" name="password" type="password" required autofocus autocomplete="current-password" placeholder="Digite a senha">
  <button type="submit">Entrar</button>
  <small>O site dos clientes continua sem senha.</small>
</form>
</body>
</html>`;
}
function requireSeller(req,res,api=false) {
  if(isLogged(req)) return true;
  if(api) send(res,401,{error:"Não autorizado"});
  else send(res,302,"","text/plain; charset=utf-8",{Location:"/login"});
  return false;
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

  if(pathname==="/login" && req.method==="GET"){
    if(isLogged(req)) return send(res,302,"","text/plain; charset=utf-8",{Location:"/vendedor"});
    return send(res,200,loginPage(),"text/html; charset=utf-8");
  }

  if(pathname==="/login" && req.method==="POST"){
    try{
      const form=querystring.parse(await bodyText(req));
      if(String(form.password||"")!==SELLER_PASSWORD){
        return send(res,401,loginPage("Senha incorreta."),"text/html; charset=utf-8");
      }
      return send(res,302,"","text/plain; charset=utf-8",{
        Location:"/vendedor",
        "Set-Cookie":`seller_session=${encodeURIComponent(sellerToken())}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=604800`
      });
    }catch{
      return send(res,400,loginPage("Não foi possível entrar."),"text/html; charset=utf-8");
    }
  }

  if(pathname==="/logout"){
    return send(res,302,"","text/plain; charset=utf-8",{
      Location:"/login",
      "Set-Cookie":"seller_session=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0"
    });
  }

  // Cliente pode ENVIAR pedidos sem login.
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
    }catch{
      return send(res,400,{error:"Pedido inválido"});
    }
  }

  // Somente vendedor logado pode visualizar ou alterar pedidos.
  if(pathname==="/api/orders" && req.method==="GET"){
    if(!requireSeller(req,res,true)) return;
    return send(res,200,readOrders());
  }

  const match=pathname.match(/^\/api\/orders\/([^/]+)$/);

  if(match && req.method==="PATCH"){
    if(!requireSeller(req,res,true)) return;
    try{
      const body=await bodyJson(req);
      const orders=readOrders();
      const o=orders.find(x=>x.id===match[1]);
      if(!o) return send(res,404,{error:"Não encontrado"});
      if(body.status==="new" || body.status==="done") o.status=body.status;
      saveOrders(orders);
      return send(res,200,o);
    }catch{
      return send(res,400,{error:"Inválido"});
    }
  }

  if(match && req.method==="DELETE"){
    if(!requireSeller(req,res,true)) return;
    const orders=readOrders();
    saveOrders(orders.filter(x=>x.id!==match[1]));
    return send(res,200,{ok:true});
  }

  let filePath;

  if(pathname==="/" || pathname==="/cliente"){
    filePath=path.join(ROOT,"pizza_do_kim_site.html");
  }else if(pathname==="/vendedor"){
    if(!requireSeller(req,res,false)) return;
    filePath=path.join(ROOT,"pizza_do_kim_vendedor.html");
  }else{
    filePath=path.join(ROOT,pathname.replace(/^\/+/,""));
  }

  if(!filePath.startsWith(ROOT)) return send(res,403,"Proibido","text/plain; charset=utf-8");

  fs.readFile(filePath,(err,data)=>{
    if(err) return send(res,404,"Não encontrado","text/plain; charset=utf-8");
    const ext=path.extname(filePath);
    const types={
      ".html":"text/html; charset=utf-8",
      ".js":"application/javascript; charset=utf-8",
      ".json":"application/json; charset=utf-8",
      ".css":"text/css; charset=utf-8",
      ".png":"image/png"
    };
    send(res,200,data,types[ext]||"application/octet-stream");
  });
});

server.listen(PORT,()=>{
  console.log(`Pizza do Kim rodando na porta ${PORT}`);
  console.log("Cliente: /cliente");
  console.log("Vendedor protegido: /vendedor");
});