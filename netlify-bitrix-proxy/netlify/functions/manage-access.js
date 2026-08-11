// Netlify Function (v2 / ESM) — gerencia login/aprovação de acesso com segurança.
//
// POR QUE ISSO EXISTE
// A tabela usuarios_acesso não aceita UPDATE nem INSERT direto pela chave
// anon (a mesma chave que já é pública no HTML do painel) — só SELECT.
// Isso impede qualquer pessoa técnica de se autoaprovar/promover chamando
// a API do Supabase direto, sem passar por aqui.
//
// Esta função é o ÚNICO lugar que cria ou grava mudança na tabela. Ela usa
// a SERVICE ROLE KEY do Supabase (que ignora RLS), guardada só como
// variável de ambiente aqui no servidor — nunca aparece no navegador.
//
// MODELO DE ACESSO
//   - Todo primeiro login (via "ensure-login") nasce com tipo "individual"
//     (rótulo na tela: "Básico") e JÁ APROVADO — não precisa de admin pra
//     começar a usar o painel no nível básico.
//   - Virar "geral" (rótulo: "Diretoria") ou "admin" só acontece se outro
//     administrador conceder isso no painel de permissões.
//   - Não existe mais lista fixa de admin no código — quem já é admin no
//     banco continua admin; não tem bootstrap automático de ninguém.
//   - O sistema nunca deixa remover/revogar o ÚLTIMO admin aprovado, pra
//     não travar o acesso de todo mundo ao painel de permissões.
//
// LIMITAÇÃO HONESTA: como o login não emite uma sessão assinada pelo
// servidor, "quem está pedindo" (requester) é só o nome de usuário que o
// próprio navegador informa — não há prova criptográfica de que quem está
// do outro lado realmente é aquele admin. Isso fecha a brecha de "chamar a
// API direto e se autoaprovar sem NUNCA ter feito login", mas ainda depende
// de que sessionStorage não seja forjado por alguém que já saiba o usuário
// de um admin de verdade. Uma proteção completa exigiria Supabase Auth ou
// um JWT assinado no login.
//
// AÇÕES (POST, body JSON)
//   { action:"ensure-login", target, nome, email }        sem requester
//   { action:"aprovar",  requester, target, tipo }        tipo: admin|geral|individual
//   { action:"revogar",  requester, target }
//   { action:"set-tipo", requester, target, tipo }

const SUPABASE_URL = process.env.SUPABASE_URL || "https://wtuurupfuldzozuxvhml.supabase.co";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "https://gcm-centraldeperformance.netlify.app";
const TIPOS_VALIDOS = ["admin", "geral", "individual"];

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

// Quantos OUTROS usuários (fora `target`) são admin aprovado agora?
async function contarOutrosAdmins(target) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/usuarios_acesso?tipo=eq.admin&aprovado=eq.true&usuario=neq.${encodeURIComponent(target)}&select=usuario`,
    { headers: SB_HEADERS() }
  );
  if (!res.ok) throw new Error(`Supabase GET ${res.status}`);
  const rows = await res.json();
  return rows.length;
}

// Confere, consultando o banco (não confiando em nada vindo do navegador
// além do NOME do usuário), se quem está pedindo já é admin aprovado.
async function ehAdminDeVerdade(usuario) {
  if (!usuario) return false;
  const reg = await buscarUsuario(usuario);
  return !!(reg && reg.aprovado && reg.tipo === "admin");
}

// true se a mudança pedida tiraria o status de "admin aprovado" de alguém
// que hoje tem esse status.
function estaSaindoDeAdmin(atual, novoTipo, novoAprovado) {
  const eraAdminAprovado = !!(atual && atual.tipo === "admin" && atual.aprovado);
  const vaiContinuarAdminAprovado = novoTipo === "admin" && novoAprovado;
  return eraAdminAprovado && !vaiContinuarAdminAprovado;
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
    // Login (qualquer usuário, sem precisar já ser admin de ninguém).
    // Nasce Básico e já aprovado; se já existir, só devolve o que já tem.
    if (action === "ensure-login") {
      if (!target) return json({ erro: "Usuário (target) obrigatório." }, 400);
      let registro = await buscarUsuario(target);
      if (!registro) {
        registro = await criarUsuario({
          usuario: target,
          nome: body.nome || target,
          email: body.email || target,
          tipo: "individual",
          aprovado: true,
        });
      }
      return json({ ok: true, registro });
    }

    // Todas as demais ações exigem que quem está pedindo já seja admin aprovado.
    if (!(await ehAdminDeVerdade(requester))) {
      return json({ erro: "Apenas administradores aprovados podem gerenciar acessos." }, 403);
    }

    if (action === "aprovar") {
      if (!TIPOS_VALIDOS.includes(tipo)) return json({ erro: "Tipo de acesso inválido." }, 400);
      const atual = await buscarUsuario(target);
      if (estaSaindoDeAdmin(atual, tipo, true) && (await contarOutrosAdmins(target)) === 0) {
        return json({ erro: "Não é possível remover o último administrador do sistema." }, 409);
      }
      const registro = await atualizarUsuario(target, { aprovado: true, tipo });
      return json({ ok: true, registro });
    }

    if (action === "revogar") {
      const atual = await buscarUsuario(target);
      if (estaSaindoDeAdmin(atual, atual?.tipo, false) && (await contarOutrosAdmins(target)) === 0) {
        return json({ erro: "Não é possível revogar o último administrador do sistema." }, 409);
      }
      const registro = await atualizarUsuario(target, { aprovado: false });
      return json({ ok: true, registro });
    }

    if (action === "set-tipo") {
      if (!TIPOS_VALIDOS.includes(tipo)) return json({ erro: "Tipo de acesso inválido." }, 400);
      const atual = await buscarUsuario(target);
      if (estaSaindoDeAdmin(atual, tipo, atual?.aprovado) && (await contarOutrosAdmins(target)) === 0) {
        return json({ erro: "Não é possível remover o último administrador do sistema." }, 409);
      }
      const registro = await atualizarUsuario(target, { tipo });
      return json({ ok: true, registro });
    }

    return json({ erro: "Ação desconhecida." }, 400);
  } catch (err) {
    console.error("manage-access falhou:", err);
    return json({ erro: "Falha ao gravar no Supabase: " + err.message }, 502);
  }
};
