// Netlify Function (v2 / ESM) — proxy para o Bitrix24
//
// Por que a v2: o formato antigo (CommonJS, event.queryStringParameters)
// recebe os parâmetros já convertidos em objeto simples pela Netlify, o que
// PERDE chaves repetidas — e "tasks.task.list" precisa enviar várias vezes
// "filter[ID][]=123&filter[ID][]=456...". A v2 usa a Request/URL padrão da
// web, que preserva chaves repetidas corretamente.
//
// MÉTODOS LIBERADOS
//   department.get     — estrutura de setores
//   user.get            — pessoas e departamento de cada uma
//   tasks.task.list      — prazo (DEADLINE), criação (CREATED_DATE) e a flag
//                          de pular finais de semana (MATCH_WORK_TIME) de
//                          cada tarefa concluída, usadas para classificar
//                          "rápida / regular / atrasada" no painel.
//
// CONFIGURAÇÃO (variável de ambiente do site na Netlify)
//   BITRIX_WEBHOOK_URL = https://gcm.bitrix24.com.br/rest/935/7ie7vmhsgev5e32p/

const BITRIX_WEBHOOK_URL = process.env.BITRIX_WEBHOOK_URL || "";

const ALLOWED_METHODS = new Set(["department.get", "user.get", "tasks.task.list"]);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

export default async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  if (!BITRIX_WEBHOOK_URL) {
    return json(
      { error: "missing_config", error_description: "BITRIX_WEBHOOK_URL não configurada nas variáveis de ambiente do site." },
      500
    );
  }

  const incoming = new URL(req.url);
  const method = incoming.searchParams.get("method") || "";

  if (!ALLOWED_METHODS.has(method)) {
    return json(
      { error: "method_not_allowed", error_description: `Método '${method}' não está na lista permitida (${[...ALLOWED_METHODS].join(", ")}).` },
      400
    );
  }

  // Reconstrói a query removendo só "method" e preservando chaves repetidas
  // (filter[ID][]=1&filter[ID][]=2, select[]=A&select[]=B, etc).
  const forward = new URLSearchParams();
  for (const [k, v] of incoming.searchParams) {
    if (k !== "method") forward.append(k, v);
  }

  try {
    const upstream = await fetch(`${BITRIX_WEBHOOK_URL}${method}.json?${forward.toString()}`);
    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (err) {
    return json({ error: "upstream_failure", error_description: String(err) }, 502);
  }
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
