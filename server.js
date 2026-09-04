const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const querystring = require("querystring");
const webpush = require("web-push");
const QRCode = require("qrcode");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DB = path.join(ROOT, "orders.json");
const PUSH_DB = path.join(ROOT, "push_subscriptions.json");

// CONFIGURAÇÕES DO VENDEDOR
const SELLER_PASSWORD =
  process.env.SELLER_PASSWORD || "troque-esta-senha";

const SESSION_SECRET =
  process.env.SESSION_SECRET || "pizza-do-kim-session-secret";

const cleanEnv = v =>
  String(v || "").trim().replace(/^["']|["']$/g, "");

const VAPID_PUBLIC_KEY =
  cleanEnv(process.env.VAPID_PUBLIC_KEY);

const VAPID_PRIVATE_KEY =
  cleanEnv(process.env.VAPID_PRIVATE_KEY);

const VAPID_SUBJECT =
  cleanEnv(process.env.VAPID_SUBJECT) ||
  "mailto:contato@pizzadokim.local";

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    VAPID_SUBJECT,
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
}

// ==========================================
// SICOOB PIX
// ==========================================

const SICOOB_CLIENT_ID =
  cleanEnv(process.env.SICOOB_CLIENT_ID);

const SICOOB_PIX_KEY =
  cleanEnv(process.env.SICOOB_PIX_KEY);

const SICOOB_AUTH_URL =
  "https://auth.sicoob.com.br/auth/realms/cooperado/protocol/openid-connect/token";

const SICOOB_PIX_URL =
  "https://api.sicoob.com.br/pix/api/v2";

const CERT_PATH =
  "/etc/secrets/certificado.pem";

const KEY_PATH =
  "/etc/secrets/chave_privada.pem";

let tokenCache = {
  token: "",
  expires: 0
};

function normalizePixKey(value) {
  const raw = String(value || "").trim();
  const digits = raw.replace(/\D/g, "");

  if (digits.length === 11) {
    return "+55" + digits;
  }

  if (
    digits.length === 13 &&
    digits.startsWith("55")
  ) {
    return "+" + digits;
  }

  return raw;
}

function sicoobReady() {
  return !!(
    SICOOB_CLIENT_ID &&
    SICOOB_PIX_KEY &&
    fs.existsSync(CERT_PATH) &&
    fs.existsSync(KEY_PATH)
  );
}

function getSicoobAgent() {
  if (!sicoobReady()) {
    throw new Error(
      "Configuração do Sicoob incompleta."
    );
  }

  return new https.Agent({
    cert: fs.readFileSync(CERT_PATH),
    key: fs.readFileSync(KEY_PATH),
    rejectUnauthorized: true
  });
}

function httpsRequest(
  url,
  {
    method = "GET",
    headers = {},
    body = null,
    agent = null
  } = {}
) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);

    let payload = null;

    if (body !== null) {
      payload =
        typeof body === "string"
          ? body
          : JSON.stringify(body);
    }

    const request = https.request(
      {
        hostname: target.hostname,
        port: target.port || 443,
        path: target.pathname + target.search,
        method,
        agent,
        headers: {
          ...headers,
          ...(payload
            ? {
                "Content-Length":
                  Buffer.byteLength(payload)
              }
            : {})
        }
      },
      response => {
        let data = "";

        response.on("data", chunk => {
          data += chunk;
        });

        response.on("end", () => {
          let parsed = data;

          try {
            parsed = data
              ? JSON.parse(data)
              : {};
          } catch {}

          if (
            response.statusCode >= 200 &&
            response.statusCode < 300
          ) {
            resolve({
              status: response.statusCode,
              data: parsed
            });

            return;
          }

          const error = new Error(
            "Sicoob HTTP " +
              response.statusCode
          );

          error.statusCode =
            response.statusCode;

          error.response = parsed;

          reject(error);
        });
      }
    );

    request.on("error", reject);

    if (payload) {
      request.write(payload);
    }

    request.end();
  });
}

async function getSicoobToken() {
  if (
    tokenCache.token &&
    Date.now() < tokenCache.expires
  ) {
    return tokenCache.token;
  }

  const form =
    new URLSearchParams({
      grant_type: "client_credentials",
      client_id: SICOOB_CLIENT_ID,
      scope: "cob.read cob.write pix.read"
    }).toString();

  const response =
    await httpsRequest(
      SICOOB_AUTH_URL,
      {
        method: "POST",
        agent: getSicoobAgent(),

        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded",

          Accept:
            "application/json"
        },

        body: form
      }
    );

  const token =
    response.data &&
    response.data.access_token;

  if (!token) {
    throw new Error(
      "Sicoob não retornou o token."
    );
  }

  const expiresIn =
    Number(
      response.data.expires_in
    ) || 300;

  tokenCache = {
    token,

    expires:
      Date.now() +
      Math.max(
        30,
        expiresIn - 30
      ) *
        1000
  };

  return token;
}

async function sicoobApi(
  apiPath,
  {
    method = "GET",
    body = null
  } = {}
) {
  const token =
    await getSicoobToken();

  return httpsRequest(
    SICOOB_PIX_URL +
      apiPath,
    {
      method,

      agent:
        getSicoobAgent(),

      headers: {
        Authorization:
          "Bearer " + token,

        client_id:
          SICOOB_CLIENT_ID,

        Accept:
          "application/json",

        ...(body
          ? {
              "Content-Type":
                "application/json"
            }
          : {})
      },

      body
    }
  );
}

function createTxid() {
  let txid =
    "PDK" +
    Date.now().toString(36) +
    crypto
      .randomBytes(10)
      .toString("hex");

  txid =
    txid.replace(
      /[^A-Za-z0-9]/g,
      ""
    );

  txid =
    txid.slice(0, 35);

  while (
    txid.length < 26
  ) {
    txid += "0";
  }

  return txid;
}

function validateAmount(value) {
  const number =
    Number(value);

  if (
    !Number.isFinite(number) ||
    number <= 0 ||
    number > 10000
  ) {
    return null;
  }

  return number.toFixed(2);
}

async function createPixCharge(
  amount
) {
  const value =
    validateAmount(amount);

  if (!value) {
    throw new Error(
      "Valor Pix inválido."
    );
  }

  const txid =
    createTxid();

  const body = {
    calendario: {
      expiracao: 900
    },

    valor: {
      original: value,
      modalidadeAlteracao: 0
    },

    chave:
      normalizePixKey(
        SICOOB_PIX_KEY
      ),

    solicitacaoPagador:
      "Pedido Pizza do Kim"
  };

  const response =
    await sicoobApi(
      "/cob/" +
        encodeURIComponent(
          txid
        ),
      {
        method: "PUT",
        body
      }
    );

  const data =
    response.data || {};

  const pixCode =
    data.pixCopiaECola ||
    data.brcode ||
    data.payload ||
    "";

  if (!pixCode) {
    throw new Error(
      "Sicoob não retornou o Pix Copia e Cola."
    );
  }

  return {
    txid:
      data.txid || txid,

    status:
      data.status || "ATIVA",

    amount:
      value,

    payload:
      pixCode,

    expiresIn:
      Number(
        data.calendario &&
          data.calendario
            .expiracao
      ) || 900
  };
}

async function checkPix(
  txid
) {
  const safe =
    String(txid || "")
      .replace(
        /[^A-Za-z0-9]/g,
        ""
      )
      .slice(0, 35);

  if (
    safe.length < 26
  ) {
    throw new Error(
      "TXID inválido."
    );
  }

  const response =
    await sicoobApi(
      "/cob/" +
        encodeURIComponent(
          safe
        )
    );

  const data =
    response.data || {};
console.log("SICOOB PIX STATUS:", data.status, "PIX RECEBIDOS:", Array.isArray(data.pix) ? data.pix.length : 0);
  const paid =
    data.status ===
      "CONCLUIDA" ||
    (
      Array.isArray(
        data.pix
      ) &&
      data.pix.length > 0
    );

  return {
    txid:
      data.txid || safe,

    status:
      data.status || "",

    paid
  };
}

// ==========================================
// BANCO DE PEDIDOS
// ==========================================

function readOrders() {
  try {
    return JSON.parse(
      fs.readFileSync(
        DB,
        "utf8"
      )
    );
  } catch {
    return [];
  }
}

function saveOrders(
  orders
) {
  fs.writeFileSync(
    DB,
    JSON.stringify(
      orders,
      null,
      2
    ),
    "utf8"
  );
}

function readPushSubscriptions() {
  try {
    return JSON.parse(
      fs.readFileSync(
        PUSH_DB,
        "utf8"
      )
    );
  } catch {
    return [];
  }
}

function savePushSubscriptions(
  list
) {
  fs.writeFileSync(
    PUSH_DB,
    JSON.stringify(
      list,
      null,
      2
    ),
    "utf8"
  );
}

function sanitizeSubscription(
  body
) {
  const orderId =
    String(
      body.orderId || ""
    ).slice(0, 100);

  const sub =
    body.subscription || {};

  const endpoint =
    String(
      sub.endpoint || ""
    ).slice(0, 2000);

  const p256dh =
    String(
      sub.keys &&
        sub.keys.p256dh ||
        ""
    ).slice(0, 500);

  const auth =
    String(
      sub.keys &&
        sub.keys.auth ||
        ""
    ).slice(0, 500);

  if (
    !orderId ||
    !endpoint ||
    !p256dh ||
    !auth
  ) {
    return null;
  }

  return {
    orderId,

    subscription: {
      endpoint,

      keys: {
        p256dh,
        auth
      }
    }
  };
}

async function notifyOrderDelivery(
  order
) {
  if (
    !VAPID_PUBLIC_KEY ||
    !VAPID_PRIVATE_KEY
  ) {
    return;
  }

  const all =
    readPushSubscriptions();

  const targets =
    all.filter(
      item =>
        item.orderId ===
        order.id
    );

  if (
    !targets.length
  ) {
    return;
  }

  const payload =
    JSON.stringify({
      title:
        "Pizza do Kim 🍕",

      body:
        "Pedido #" +
        order.number +
        ": sua pizza saiu para entrega! 🛵",

      icon:
        "/icon-192.png",

      badge:
        "/icon-192.png",

      url:
        "/cliente",

      orderId:
        order.id
    });

  const dead =
    new Set();

  await Promise.all(
    targets.map(
      async item => {
        try {
          await webpush
            .sendNotification(
              item.subscription,
              payload
            );
        } catch (error) {
          if (
            error &&
            (
              error.statusCode ===
                404 ||
              error.statusCode ===
                410
            )
          ) {
            dead.add(
              item.subscription
                .endpoint
            );
          } else {
            console.error(
              "Erro push:",
              error &&
                error.message ||
                error
            );
          }
        }
      }
    )
  );

  if (dead.size) {
    savePushSubscriptions(
      all.filter(
        item =>
          !dead.has(
            item.subscription &&
              item.subscription
                .endpoint
          )
      )
    );
  }
}

// ==========================================
// FUNÇÕES HTTP
// ==========================================

function send(
  res,
  code,
  data,
  type =
    "application/json; charset=utf-8",
  extraHeaders = {}
) {
  res.writeHead(
    code,
    {
      "Content-Type":
        type,

      "Cache-Control":
        "no-store",

      ...extraHeaders
    }
  );

  const body =
    type.startsWith(
      "application/json"
    ) &&
    !Buffer.isBuffer(data)
      ? JSON.stringify(data)
      : data;

  res.end(body);
}

function bodyText(req) {
  return new Promise(
    (
      resolve,
      reject
    ) => {
      let data = "";

      req.on(
        "data",
        chunk => {
          data += chunk;

          if (
            data.length >
            1000000
          ) {
            reject(
              new Error(
                "too large"
              )
            );

            req.destroy();
          }
        }
      );

      req.on(
        "end",
        () =>
          resolve(data)
      );

      req.on(
        "error",
        reject
      );
    }
  );
}

async function bodyJson(
  req
) {
  return JSON.parse(
    (
      await bodyText(req)
    ) || "{}"
  );
}

function getCookies(req) {
  const cookies = {};

  const raw =
    req.headers.cookie ||
    "";

  raw
    .split(";")
    .forEach(part => {
      const index =
        part.indexOf("=");

      if (index > 0) {
        cookies[
          part
            .slice(0, index)
            .trim()
        ] =
          decodeURIComponent(
            part
              .slice(index + 1)
              .trim()
          );
      }
    });

  return cookies;
}

function sellerToken() {
  return crypto
    .createHmac(
      "sha256",
      SESSION_SECRET
    )
    .update(
      "pizza-do-kim:" +
        SELLER_PASSWORD
    )
    .digest("hex");
}

function isLogged(req) {
  const value =
    getCookies(req)
      .seller_session ||
    "";

  const expected =
    sellerToken();

  const a =
    Buffer.from(value);

  const b =
    Buffer.from(expected);

  return (
    a.length ===
      b.length &&
    crypto.timingSafeEqual(
      a,
      b
    )
  );
}

function loginPage(
  error = ""
) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Pizza do Kim - Login</title>

<style>
*{box-sizing:border-box}

body{
margin:0;
min-height:100vh;
display:grid;
place-items:center;
padding:20px;
font-family:Arial,Helvetica,sans-serif;
background:#fff8ef;
color:#211a18
}

.card{
width:min(100%,420px);
background:#fff;
border:1px solid #eaded6;
border-radius:20px;
padding:28px;
box-shadow:0 12px 35px #4b221217
}

.logo{
width:88px;
height:88px;
border-radius:50%;
display:block;
margin:0 auto 16px;
object-fit:cover;
background:#a71919
}

h1{
text-align:center;
color:#a71919;
margin:0 0 8px
}

p{
text-align:center;
color:#716762
}

label{
display:block;
font-weight:800;
margin:10px 0 7px
}

input{
width:100%;
min-height:52px;
border:1px solid #d8ccc5;
border-radius:12px;
padding:12px 14px;
font-size:18px
}

button{
width:100%;
min-height:52px;
border:0;
border-radius:12px;
background:#a71919;
color:white;
font-size:17px;
font-weight:900;
margin-top:14px
}

.error{
background:#fff0ef;
color:#8d1212;
border:1px solid #f0b7b2;
border-radius:10px;
padding:10px;
margin-bottom:14px;
text-align:center
}
</style>

</head>

<body>

<form
class="card"
method="POST"
action="/login"
>

<img
class="logo"
src="/icon-192.png"
alt="Pizza do Kim"
>

<h1>Pizza do Kim</h1>

<p>
Painel do vendedor<br>
Entre para acessar os pedidos.
</p>

${
  error
    ? `<div class="error">${error}</div>`
    : ""
}

<label>
Senha
</label>

<input
name="password"
type="password"
required
autofocus
>

<button type="submit">
Entrar
</button>

</form>

</body>
</html>`;
}

function requireSeller(
  req,
  res,
  api = false
) {
  if (
    isLogged(req)
  ) {
    return true;
  }

  if (api) {
    send(
      res,
      401,
      {
        error:
          "Não autorizado"
      }
    );
  } else {
    send(
      res,
      302,
      "",
      "text/plain; charset=utf-8",
      {
        Location:
          "/login"
      }
    );
  }

  return false;
}

function sanitizeOrder(
  body
) {
  const items =
    Array.isArray(
      body.items
    )
      ? body.items
          .slice(0, 50)
          .map(item => ({
            title:
              String(
                item.title ||
                  "Item"
              ).slice(
                0,
                100
              ),

            detail:
              String(
                item.detail ||
                  ""
              ).slice(
                0,
                300
              ),

            obs:
              String(
                item.obs ||
                  ""
              ).slice(
                0,
                300
              ),

            qty:
              Math.max(
                1,
                Math.min(
                  50,
                  Number(
                    item.qty
                  ) || 1
                )
              ),

            unit:
              Math.max(
                0,
                Number(
                  item.unit
                ) || 0
              )
          }))
      : [];

  const subtotal =
    items.reduce(
      (
        total,
        item
      ) =>
        total +
        item.qty *
          item.unit,
      0
    );

  const deliveryFee =
    Math.max(
      0,
      Number(
        body.deliveryFee
      ) || 0
    );

  return {
    customer: {
      name:
        String(
          body.customer &&
            body.customer
              .name ||
            ""
        ).slice(
          0,
          100
        ),

      phone:
        String(
          body.customer &&
            body.customer
              .phone ||
            ""
        ).slice(
          0,
          40
        ),

      address:
        String(
          body.customer &&
            body.customer
              .address ||
            ""
        ).slice(
          0,
          220
        ),

      reference:
        String(
          body.customer &&
            body.customer
              .reference ||
            ""
        ).slice(
          0,
          180
        ),

      payment:
        String(
          body.customer &&
            body.customer
              .payment ||
            ""
        ).slice(
          0,
          80
        ),

      change:
        String(
          body.customer &&
            body.customer
              .change ||
            ""
        ).slice(
          0,
          80
        )
    },

    items,

    subtotal,

    deliveryFee,

    total:
      subtotal +
      deliveryFee
  };
}

// ==========================================
// SERVIDOR
// ==========================================

const server =
  http.createServer(
    async (
      req,
      res
    ) => {
      const u =
        new URL(
          req.url,
          `http://${req.headers.host}`
        );

      const pathname =
        u.pathname;

      // LOGIN

      if (
        pathname ===
          "/login" &&
        req.method ===
          "GET"
      ) {
        if (
          isLogged(req)
        ) {
          return send(
            res,
            302,
            "",
            "text/plain; charset=utf-8",
            {
              Location:
                "/vendedor"
            }
          );
        }

        return send(
          res,
          200,
          loginPage(),
          "text/html; charset=utf-8"
        );
      }

      if (
        pathname ===
          "/login" &&
        req.method ===
          "POST"
      ) {
        try {
          const form =
            querystring.parse(
              await bodyText(
                req
              )
            );

          if (
            String(
              form.password ||
                ""
            ) !==
            SELLER_PASSWORD
          ) {
            return send(
              res,
              401,
              loginPage(
                "Senha incorreta."
              ),
              "text/html; charset=utf-8"
            );
          }

          return send(
            res,
            302,
            "",
            "text/plain; charset=utf-8",
            {
              Location:
                "/vendedor",

              "Set-Cookie":
                `seller_session=${encodeURIComponent(
                  sellerToken()
                )}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=604800`
            }
          );
        } catch {
          return send(
            res,
            400,
            loginPage(
              "Não foi possível entrar."
            ),
            "text/html; charset=utf-8"
          );
        }
      }

      if (
        pathname ===
        "/logout"
      ) {
        return send(
          res,
          302,
          "",
          "text/plain; charset=utf-8",
          {
            Location:
              "/login",

            "Set-Cookie":
              "seller_session=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0"
          }
        );
      }

      // ==================================
      // PIX SICOOB
      // ==================================

      if (
        pathname ===
          "/api/pix/create" &&
        req.method ===
          "POST"
      ) {
        try {
          if (
            !sicoobReady()
          ) {
            return send(
              res,
              503,
              {
                error:
                  "Pix Sicoob ainda não está configurado."
              }
            );
          }

          const body =
            await bodyJson(
              req
            );

          const charge =
            await createPixCharge(
              body.amount
            );

          return send(
            res,
            201,
            charge
          );
        } catch (error) {
          console.error(
            "Erro criar Pix:",
            error.message,
            error.response ||
              ""
          );

          return send(
            res,
            502,
            {
              error:
                "Não foi possível gerar o Pix pelo Sicoob."
            }
          );
        }
      }

      if (
        pathname ===
          "/api/pix/status" &&
        req.method ===
          "GET"
      ) {
        try {
          const txid =
            u.searchParams.get(
              "txid"
            );

          const status =
            await checkPix(
              txid
            );

          return send(
            res,
            200,
            status
          );
        } catch (error) {
          console.error(
            "Erro consultar Pix:",
            error.message,
            error.response ||
              ""
          );

          return send(
            res,
            502,
            {
              error:
                "Não foi possível verificar o pagamento."
            }
          );
        }
      }

      // ==================================
      // PUSH
      // ==================================

      if (
        pathname ===
          "/api/push/public-key" &&
        req.method ===
          "GET"
      ) {
        if (
          !VAPID_PUBLIC_KEY
        ) {
          return send(
            res,
            503,
            {
              error:
                "Push ainda não configurado"
            }
          );
        }

        return send(
          res,
          200,
          {
            publicKey:
              VAPID_PUBLIC_KEY
          }
        );
      }

      if (
        pathname ===
          "/api/push/subscribe" &&
        req.method ===
          "POST"
      ) {
        try {
          const data =
            sanitizeSubscription(
              await bodyJson(
                req
              )
            );

          if (!data) {
            return send(
              res,
              400,
              {
                error:
                  "Assinatura inválida"
              }
            );
          }

          const order =
            readOrders().find(
              item =>
                item.id ===
                data.orderId
            );

          if (!order) {
            return send(
              res,
              404,
              {
                error:
                  "Pedido não encontrado"
              }
            );
          }

          const list =
            readPushSubscriptions();

          const endpoint =
            data.subscription
              .endpoint;

          const filtered =
            list.filter(
              item =>
                item.subscription &&
                item.subscription
                  .endpoint !==
                  endpoint
            );

          filtered.push({
            ...data,
            createdAt:
              new Date()
                .toISOString()
          });

          savePushSubscriptions(
            filtered.slice(
              -5000
            )
          );

          return send(
            res,
            201,
            {
              ok: true
            }
          );
        } catch {
          return send(
            res,
            400,
            {
              error:
                "Não foi possível ativar notificações"
            }
          );
        }
      }

      // ==================================
      // PEDIDOS
      // ==================================

      if (
        pathname ===
          "/api/orders" &&
        req.method ===
          "POST"
      ) {
        try {
          const raw =
            await bodyJson(
              req
            );

          const body =
            sanitizeOrder(
              raw
            );

          if (
            !body.items.length
          ) {
            return send(
              res,
              400,
              {
                error:
                  "Pedido vazio"
              }
            );
          }

          if (
            !body.customer.name ||
            !body.customer.phone ||
            !body.customer.address
          ) {
            return send(
              res,
              400,
              {
                error:
                  "Dados do cliente incompletos"
              }
            );
          }

          // Se for Pix, confirma no Sicoob
          // antes de aceitar o pedido.

          let pixTxid = "";

          if (
            body.customer
              .payment ===
            "Pix"
          ) {
            pixTxid =
              String(
                raw.paymentTxid ||
                  ""
              );

            if (!pixTxid) {
              return send(
                res,
                402,
                {
                  error:
                    "Pagamento Pix ainda não confirmado."
                }
              );
            }

            const pix =
              await checkPix(
                pixTxid
              );

            if (!pix.paid) {
              return send(
                res,
                402,
                {
                  error:
                    "Pagamento Pix ainda não foi aprovado."
                }
              );
            }

            // Impede reutilizar o mesmo Pix
            const alreadyUsed =
              readOrders().some(
                order =>
                  order.pixTxid ===
                  pixTxid
              );

            if (
              alreadyUsed
            ) {
              return send(
                res,
                409,
                {
                  error:
                    "Este pagamento Pix já foi utilizado."
                }
              );
            }
          }

          const orders =
            readOrders();

          const order = {
            id:
              crypto.randomUUID(),

            number:
              String(
                Date.now()
              ).slice(-6),

            createdAt:
              new Date()
                .toISOString(),

            status:
              "new",

            pixTxid,

            ...body
          };

          orders.push(
            order
          );

          saveOrders(
            orders
          );

          return send(
            res,
            201,
            order
          );
        } catch (error) {
          console.error(
            "Erro pedido:",
            error.message ||
              error
          );

          return send(
            res,
            400,
            {
              error:
                "Pedido inválido"
            }
          );
        }
      }

      if (
        pathname ===
          "/api/orders" &&
        req.method ===
          "GET"
      ) {
        if (
          !requireSeller(
            req,
            res,
            true
          )
        ) {
          return;
        }

        return send(
          res,
          200,
          readOrders()
        );
      }

      const match =
        pathname.match(
          /^\/api\/orders\/([^/]+)$/
        );

      if (
        match &&
        req.method ===
          "GET"
      ) {
        const order =
          readOrders().find(
            item =>
              item.id ===
              match[1]
          );

        if (!order) {
          return send(
            res,
            404,
            {
              error:
                "Pedido não encontrado"
            }
          );
        }

        return send(
          res,
          200,
          {
            id:
              order.id,

            number:
              order.number,

            status:
              order.status,

            createdAt:
              order.createdAt
          }
        );
      }

      if (
        match &&
        req.method ===
          "PATCH"
      ) {
        if (
          !requireSeller(
            req,
            res,
            true
          )
        ) {
          return;
        }

        try {
          const body =
            await bodyJson(
              req
            );

          const orders =
            readOrders();

          const order =
            orders.find(
              item =>
                item.id ===
                match[1]
            );

          if (!order) {
            return send(
              res,
              404,
              {
                error:
                  "Não encontrado"
              }
            );
          }

          const previous =
            order.status;

          if (
            body.status ===
              "new" ||
            body.status ===
              "done"
          ) {
            order.status =
              body.status;
          }

          saveOrders(
            orders
          );

          if (
            previous !==
              "done" &&
            order.status ===
              "done"
          ) {
            notifyOrderDelivery(
              order
            ).catch(
              error =>
                console.error(
                  "Push:",
                  error
                )
            );
          }

          return send(
            res,
            200,
            order
          );
        } catch {
          return send(
            res,
            400,
            {
              error:
                "Inválido"
            }
          );
        }
      }

      if (
        match &&
        req.method ===
          "DELETE"
      ) {
        if (
          !requireSeller(
            req,
            res,
            true
          )
        ) {
          return;
        }

        const orders =
          readOrders();

        saveOrders(
          orders.filter(
            item =>
              item.id !==
              match[1]
          )
        );

        return send(
          res,
          200,
          {
            ok: true
          }
        );
      }

      // ==================================
      // ARQUIVOS DO SITE
      // ==================================

      let filePath;

      if (
        pathname === "/" ||
        pathname ===
          "/cliente"
      ) {
        filePath =
          path.join(
            ROOT,
            "pizza_do_kim_site.html"
          );
      } else if (
        pathname ===
        "/vendedor"
      ) {
        if (
          !requireSeller(
            req,
            res,
            false
          )
        ) {
          return;
        }

        filePath =
          path.join(
            ROOT,
            "pizza_do_kim_vendedor.html"
          );
      } else {
        filePath =
          path.join(
            ROOT,
            pathname.replace(
              /^\/+/,
              ""
            )
          );
      }

      if (
        !filePath.startsWith(
          ROOT
        )
      ) {
        return send(
          res,
          403,
          "Proibido",
          "text/plain; charset=utf-8"
        );
      }

      fs.readFile(
        filePath,
        (
          error,
          data
        ) => {
          if (error) {
            return send(
              res,
              404,
              "Não encontrado",
              "text/plain; charset=utf-8"
            );
          }

          const ext =
            path.extname(
              filePath
            );

          const types = {
            ".html":
              "text/html; charset=utf-8",

            ".js":
              "application/javascript; charset=utf-8",

            ".json":
              "application/json; charset=utf-8",

            ".css":
              "text/css; charset=utf-8",

            ".png":
              "image/png"
          };

          send(
            res,
            200,
            data,
            types[ext] ||
              "application/octet-stream"
          );
        }
      );
    }
  );

server.listen(
  PORT,
  () => {
    console.log(
      "Pizza do Kim rodando na porta " +
        PORT
    );

    console.log(
      "Cliente: /cliente"
    );

    console.log(
      "Vendedor: /vendedor"
    );

    console.log(
      "Sicoob Pix: " +
        (
          sicoobReady()
            ? "configurado"
            : "não configurado"
        )
    );
  }
);
