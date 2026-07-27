// Netlify Function — proxy para o Bitrix24
//
// POR QUE ISSO EXISTE
// O navegador bloqueia chamadas diretas de JS para o webhook do Bitrix24
// porque o Bitrix não devolve o cabeçalho Access-Control-Allow-Origin
// (erro típico no console: "Failed to fetch" / "CORS policy"). Além disso,
// deixar o webhook exposto no HTML público não é recomendado pelo próprio
// Bitrix ("do not embed it in public web pages or scripts").
//
// Esta função roda no servidor da Netlify (não no navegador), então:
//   1) a chamada ao Bitrix não sofre bloqueio de CORS (CORS é regra de navegador);
//   2) o token do webhook fica guardado como variável de ambiente, fora do HTML;
//   3) a função responde ao navegador já com os cabeçalhos de CORS liberados.
//
// COMO O PAINEL CHAMA
//   GET {URL_DA_FUNCAO}?method=department.get
//   GET {URL_DA_FUNCAO}?method=user.get&ACTIVE=true&start=0

const BITRIX_WEBHOOK_URL = process.env.BITRIX_WEBHOOK_URL || "";

// Só estes métodos passam pelo proxy — mantém a superfície de risco pequena
// mesmo que o webhook em si tenha permissões mais amplas.
const ALLOWED_METHODS = new Set(["department.get", "user.get"]);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }

  if (!BITRIX_WEBHOOK_URL) {
    return json(
      { error: "missing_config", error_description: "BITRIX_WEBHOOK_URL não configurada nas variáveis de ambiente do site (Site settings → Environment variables)." },
      500
    );
  }

  const params = new URLSearchParams(event.queryStringParameters || {});
  const method = params.get("method") || "";

  if (!ALLOWED_METHODS.has(method)) {
    return json(
      { error: "method_not_allowed", error_description: `Método '${method}' não está na lista permitida (${[...ALLOWED_METHODS].join(", ")}).` },
      400
    );
  }

  params.delete("method");

  try {
    const upstream = await fetch(`${BITRIX_WEBHOOK_URL}${method}.json?${params.toString()}`);
    const body = await upstream.text();
    return {
      statusCode: upstream.status,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      body,
    };
  } catch (err) {
    return json({ error: "upstream_failure", error_description: String(err) }, 502);
  }
};

function json(obj, statusCode) {
  return {
    statusCode,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}
