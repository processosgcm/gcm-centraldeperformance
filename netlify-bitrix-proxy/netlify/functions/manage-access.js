// Netlify Function (v2 / ESM) — gerencia aprovações de acesso com segurança.
//
// POR QUE ISSO EXISTE
// A tabela usuarios_acesso não aceita mais UPDATE direto pela chave anon
// (a mesma chave que já é pública no HTML do painel). Antes, isso permitia
// que qualquer pessoa técnica se autoaprovasse como admin chamando a API
// do Supabase direto, sem passar pela tela — ver aviso no usuarios_acesso.sql.
//
// Esta função é o ÚNICO lugar que grava aprovação/tipo/revogação. Ela usa a
// SERVICE ROLE KEY do Supabase (que ignora RLS), guardada só como variável
// de ambiente aqui no servidor — nunca aparece no navegador. Antes de gravar
// qualquer mudança, ela confere se quem está pedindo (`requester`) já é um
// admin aprovado, consultando o banco.
//
// LIMITAÇÃO HONESTA: como o login não emite uma sessão assinada pelo
// servidor, "quem está pedindo" aqui é só o nome de usuário que o próprio
// navegador informa — não há prova criptográfica de que quem está do outro
// lado realmente é aquele admin. Isso fecha a brecha de "chamar a API direto
// e se autoaprovar sem NUNCA ter feito login", mas ainda depende de que
// sessionStorage não seja forjado por alguém que já saiba o usuário de um
// admin de verdade. Uma proteção completa exigiria Supabase Auth ou um JWT
// assinado no login.
//
// AÇÕES (POST, body JSON)
//   { action:"aprovar",  requester, target, tipo }   tipo: admin|geral|individual
//   { action:"revogar",  requester, target }
//   { action:"set-tipo", requester, target, tipo }
//   { action:"ensure-admin", target }                 sem requester — só para
//                                                      os admins fixos, ver abaixo

const SUPABASE_URL = process.env.SUPABASE_URL || "https://wtuurupfuldzozuxvhml.supabase.co";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const ADMINS_FIXOS = ["rafael.pieretti", "caroline.queiroz"];
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "https://gcm-centraldeperformance.netlify.app";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
}

const SB_HEADERS = () => ({
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
});

async function buscarUsuario(usuario) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/usuarios_acesso?usuario=eq.${encodeURIComponent(usuario)}&select=*`, {
    headers: SB_HEADERS(),
  });
  if (!res.ok) throw new Error(`Supabase GET ${res.status}`);
  const rows = await res.json();
  return rows[0] || null;
}

async function atualizarUsuario(usuario, patch) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/usuarios_acesso?usuario=eq.${encodeURIComponent(usuario)}`, {
    method: "PATCH",
    headers: { ...SB_HEADERS(), Prefer: "return=representation" },
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`Supabase PATCH ${res.status}`);
  const rows = await res.json();
  return rows[0];
}

async function criarUsuario(row) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/usuarios_acesso`, {
    method: "POST",
    headers: { ...SB_HEADERS(), Prefer: "return=representation,resolution=merge-duplicates" },
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error(`Supabase POST ${res.status}`);
  const rows = await res.json();
  return rows[0];
}

// Confere, consultando o banco (não confiando em nada vindo do navegador
// além do NOME do usuário), se quem está pedindo já é admin aprovado.
async function ehAdminDeVerdade(usuario) {
  if (!usuario) return false;
  const reg = await buscarUsuario(usuario);
  return !!(reg && reg.aprovado && reg.tipo === "admin");
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ erro: "Método não permitido." }, 405);
  if (!SERVICE_KEY) return json({ erro: "Backend sem configuração: SUPABASE_SERVICE_ROLE_KEY não definida." }, 500);

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ erro: "Corpo inválido (esperado JSON)." }, 400);
  }

  const { action, requester, target, tipo } = body;

  try {
    // Auto-provisionamento dos dois admins fixos, logo após o login válido
    // com a Senior. Não depende de "requester" ser admin (ninguém é admin
    // ainda na primeira vez) — só aceita se `target` estiver na lista fixa
    // de usuários, decidida aqui no servidor, não pelo que o navegador manda.
    if (action === "ensure-admin") {
      if (!ADMINS_FIXOS.includes(target)) {
        return json({ erro: "Usuário não está na lista de administradores fixos." }, 403);
      }
      const existente = await buscarUsuario(target);
      let registro;
      if (!existente) {
        registro = await criarUsuario({ usuario: target, nome: target, email: target, tipo: "admin", aprovado: true });
      } else if (!existente.aprovado || existente.tipo !== "admin") {
        registro = await atualizarUsuario(target, { tipo: "admin", aprovado: true });
      } else {
        registro = existente;
      }
      return json({ ok: true, registro });
    }

    if (!(await ehAdminDeVerdade(requester))) {
      return json({ erro: "Apenas administradores aprovados podem gerenciar acessos." }, 403);
    }

    if (action === "aprovar") {
      if (!["admin", "geral", "individual"].includes(tipo)) return json({ erro: "Tipo de acesso inválido." }, 400);
      const registro = await atualizarUsuario(target, { aprovado: true, tipo });
      return json({ ok: true, registro });
    }
    if (action === "revogar") {
      const registro = await atualizarUsuario(target, { aprovado: false });
      return json({ ok: true, registro });
    }
    if (action === "set-tipo") {
      if (!["admin", "geral", "individual"].includes(tipo)) return json({ erro: "Tipo de acesso inválido." }, 400);
      const registro = await atualizarUsuario(target, { tipo });
      return json({ ok: true, registro });
    }

    return json({ erro: "Ação desconhecida." }, 400);
  } catch (err) {
    console.error("manage-access falhou:", err);
    return json({ erro: "Falha ao gravar no Supabase: " + err.message }, 502);
  }
};
