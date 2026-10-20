import {readFile} from 'node:fs/promises';
const config=JSON.parse(await readFile(new URL('../wrangler.jsonc',import.meta.url),'utf8'));
if(!/^[0-9a-f-]{36}$/i.test(config.d1_databases?.[0]?.database_id||'')){
  throw Error('Configure o banco D1 no wrangler.jsonc antes de publicar. Consulte PUBLICACAO.md.');
}
console.log('Banco D1 configurado. O acesso administrativo depende das variáveis Access no painel Cloudflare e permanece bloqueado até sua configuração.');
