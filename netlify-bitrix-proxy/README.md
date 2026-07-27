# Proxy Bitrix24 — Netlify Functions

Resolve dois problemas do painel Central de Performance:
1. O Bitrix24 bloqueia chamadas diretas do navegador (CORS).
2. O token do webhook deixa de ficar exposto no HTML público.

## Passo a passo (via Netlify CLI — recomendado)

1. Instale a CLI (uma vez só, no seu computador):
   ```
   npm install -g netlify-cli
   ```

2. Dentro desta pasta (`netlify-bitrix-proxy`), faça login e crie/linke o site:
   ```
   netlify login
   netlify init
   ```
   Escolha **"Create & configure a new site"** (ou "Link this directory to an existing site" se já tiver um).

3. Configure o webhook do Bitrix como variável de ambiente (nunca vai para o código):
   ```
   netlify env:set BITRIX_WEBHOOK_URL "https://gcm.bitrix24.com.br/rest/935/7ie7vmhsgev5e32p/"
   ```

4. Publique:
   ```
   netlify deploy --prod
   ```

5. Ao final do deploy a CLI mostra a URL do site, algo como
   `https://seu-site.netlify.app`. A função fica acessível em:
   ```
   https://seu-site.netlify.app/.netlify/functions/bitrix-proxy
   ```

6. Copie essa URL e cole em `BITRIX_PROXY_URL` no topo do `<script>` do
   arquivo `central-performance.html`. Recarregue o painel — a barra de
   status no topo deve mostrar o ponto do Bitrix em verde.

## Alternativa: conectar um repositório Git

Se preferir não usar a CLI, suba esta pasta para um repositório (GitHub/
GitLab/Bitbucket) e conecte em **app.netlify.com → Add new site → Import
an existing project**. A Netlify detecta o `netlify.toml` e publica a
função automaticamente. Configure `BITRIX_WEBHOOK_URL` em **Site
settings → Environment variables** antes do primeiro deploy.

## Testar se está funcionando

Depois de publicado, abra direto no navegador:
```
https://seu-site.netlify.app/.netlify/functions/bitrix-proxy?method=department.get
```
Deve devolver um JSON com a lista de departamentos. Se aparecer
`missing_config`, a variável de ambiente não foi salva — confira o passo 3.
