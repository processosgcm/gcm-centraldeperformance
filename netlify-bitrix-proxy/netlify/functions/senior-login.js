// Netlify Function (v2 / ESM) — login de colaborador via SOAP gcmLogin (Senior)
//
// Segue à risca o guia GUIA_LOGIN_SOAP_gcmLogin.md:
//   - o navegador NUNCA fala com o SOAP da Senior diretamente (CORS + credenciais expostas);
//   - só este backend conhece USER/PASSWORD da conta de integração (variáveis de ambiente);
//   - o front-end só recebe { autenticado, email, mensagem } — nunca a credencial de integração.
//
// Monta o envelope XML na mão (em vez de usar uma lib SOAP), porque bibliotecas
// SOAP costumam ter problemas com o bundler de funções serverless. A operação
// usada é "Exportar" (autentica e já traz as abrangências do colaborador).
//
// VARIÁVEIS DE AMBIENTE (Site configuration → Environment variables)
//   SOAP_SERVICE_USER      → usuário da conta de integração (não o do colaborador)
//   SOAP_SERVICE_PASSWORD  → senha da conta de integração
//   SOAP_ENDPOINT_URL      → opcional; padrão é o endereço do guia
//   SOAP_ENCRYPTION        → opcional; padrão 0 (texto puro) — confirme com o time Senior
//
// COMO O FRONT CHAMA
//   POST {URL_DA_FUNÇÃO}   body: { "usuario": "...", "senha": "..." }

const DEFAULT_ENDPOINT =
  "https://ocweb08s1p.seniorcloud.com.br:30271/g5-senior-services/sapiens_Synccom_senior_g5_co_cus_gcmLogin";

const SOAP_ENDPOINT_URL = process.env.SOAP_ENDPOINT_URL || DEFAULT_ENDPOINT;
const SOAP_SERVICE_USER = process.env.SOAP_SERVICE_USER || "";
const SOAP_SERVICE_PASSWORD = process.env.SOAP_SERVICE_PASSWORD || "";
const SOAP_ENCRYPTION = process.env.SOAP_ENCRYPTION || "0";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

// ── proteção simples contra força bruta ──────────────────────────────────
// Limitação honesta: funções serverless não mantêm estado entre instâncias,
// então isto só barra tentativas repetidas rápidas na MESMA instância quente.
// Para produção de verdade, use um rate-limit externo (Netlify Rate Limiting,
// Upstash Redis, etc.) — ver README.
const attempts = new Map(); // ip -> [timestamps]
const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 8;
function tooManyAttempts(ip) {
  const now = Date.now();
  const list = (attempts.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  list.push(now);
  attempts.set(ip, list);
  return list.length > MAX_ATTEMPTS;
}

function escapeXml(s) {
  return String(s ?? "").replace(/[<>&'"]/g, (c) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;",
  }[c]));
}

function buildEnvelope(usuario, senha) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <Exportar xmlns="http://services.senior.com.br">
      <user>${escapeXml(SOAP_SERVICE_USER)}</user>
      <password>${escapeXml(SOAP_SERVICE_PASSWORD)}</password>
      <encryption>${escapeXml(SOAP_ENCRYPTION)}</encryption>
      <parameters>
        <gcmUser>${escapeXml(usuario)}</gcmUser>
        <gcmPass>${escapeXml(senha)}</gcmPass>
        <flowName></flowName>
        <flowInstanceID></flowInstanceID>
      </parameters>
    </Exportar>
  </soap:Body>
</soap:Envelope>`;
}

// Extração simples por regex — a resposta é uma lista fixa e plana de tags,
// então não vale a pena carregar um parser XML completo num serverless.
function extractTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? m[1].trim() : null;
}
function extractAbrangencias(xml) {
  const blocks = [...xml.matchAll(/<gcmAbrangencias[^>]*>([\s\S]*?)<\/gcmAbrangencias>/gi)];
  return blocks.map(([, block]) => ({
    codFilial: extractTag(block, "CODFIL"),
    codUsuario: extractTag(block, "CODUSU"),
    numEmpresa: extractTag(block, "NUMEMP"),
    seqAbrangencia: extractTag(block, "SEQABR"),
  }));
}

export default async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return json({ autenticado: false, mensagem: "Método não permitido." }, 405);
  }

  if (!SOAP_SERVICE_USER || !SOAP_SERVICE_PASSWORD) {
    return json(
      { autenticado: false, mensagem: "Backend sem configuração: SOAP_SERVICE_USER / SOAP_SERVICE_PASSWORD não definidas." },
      500
    );
  }

  const ip = req.headers.get("x-nf-client-connection-ip") || req.headers.get("x-forwarded-for") || "unknown";
  if (tooManyAttempts(ip)) {
    return json({ autenticado: false, mensagem: "Muitas tentativas. Aguarde um minuto e tente novamente." }, 429);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ autenticado: false, mensagem: "Corpo da requisição inválido (esperado JSON)." }, 400);
  }

  const usuario = (body.usuario || "").trim();
  const senha = body.senha || "";
  if (!usuario || !senha) {
    return json({ autenticado: false, mensagem: "Informe usuário e senha." }, 400);
  }

  try {
    const upstream = await fetch(SOAP_ENDPOINT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "text/xml; charset=utf-8",
        "SOAPAction": '""',
      },
      body: buildEnvelope(usuario, senha),
    });

   const xml = await upstream.text();
console.log("XML bruto da Senior:", xml);   // ← linha temporária de diagnóstico

    if (!upstream.ok) {
      console.error("Senior SOAP HTTP", upstream.status, xml.slice(0, 500));
      return json({ autenticado: false, mensagem: "Serviço de autenticação indisponível no momento." }, 502);
    }

const erroExecucao = extractTag(xml, "erroExecucao");

const gcmAutenticadoRaw = (extractTag(xml, "gcmAutenticado") || "").toLowerCase();
const autenticado = ["true", "s", "sim", "1"].includes(gcmAutenticadoRaw);
const email = extractTag(xml, "email");
const mensagemRetorno = extractTag(xml, "mensagem");
const abrangencias = extractAbrangencias(xml);

return json({
  autenticado,
  email: autenticado ? email : null,
  abrangencias: autenticado ? abrangencias : [],
  mensagem:
    mensagemRetorno ||
    erroExecucao ||
    (autenticado ? "Login válido" : "Usuário ou senha inválidos"),
});
  } catch (err) {
    console.error("Senior SOAP falhou:", err);
    return json({ autenticado: false, mensagem: "Não foi possível contatar o serviço de autenticação (rede/firewall)." }, 502);
  }
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
