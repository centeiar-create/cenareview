# Publicar a Cena pelo GitHub na Cloudflare

Repositório: `centeiar-create/cenareview` · branch: `main` · diretório raiz: `/`.

## Recursos

- Worker: `cena-revisao`.
- D1: `cena-revisao`, binding `DB`. O identificador está configurado em `wrangler.jsonc`.
- R2: `cena-revisao-videos`, binding `BUCKET`, **privado**.
- Limites no aplicativo: 1 GB no total, 100 MB por vídeo, 200 arquivos ativos, retenção de 30 dias.

As tabelas das duas migrações iniciais foram preparadas no banco exclusivo da Cena. Os arquivos SQL originais e o histórico de migração foram preservados.

## Workers Builds

Em Workers & Pages, crie uma aplicação conectada ao GitHub e selecione `cenareview`.

| Campo | Valor |
| --- | --- |
| Nome | `cena-revisao` |
| Branch de produção | `main` |
| Diretório raiz | `/` |
| Instalação | `npm ci` (detectado pelo package-lock) |
| Comando de build | `npm run check && npm test` |
| Comando de deploy | `npm run deploy` |

Para migrações futuras, execute `npm run db:migrate` com acesso autorizado à conta antes da publicação que depende delas. Não apague tabelas para repetir a instalação.

## Administração

As variáveis `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` e `OWNER_EMAIL` ficam em **Worker → Settings → Variables and Secrets**. Não coloque chaves, cookies ou senhas no GitHub. `keep_vars: true` preserva as variáveis definidas no painel nas próximas publicações.

Crie uma aplicação Access do tipo self-hosted para os caminhos `/admin`, `/admin/*` e `/api/admin/*`. Todos devem usar a mesma aplicação/audiência. Permita somente o e-mail do administrador. O Worker também verifica a assinatura do JWT e o e-mail autorizado; sem configuração, a administração fica bloqueada.

Os caminhos `/r/*` e `/api/review/*` continuam fora do login Access. O revisor usa o link e informa nome/e-mail somente para comentar. O e-mail não é verificado e fica visível apenas na administração.

## Vídeos

No R2, mantenha o acesso público desabilitado e crie uma regra de ciclo de vida para excluir o prefixo `review-videos/` após 30 dias. O Worker bloqueia a reprodução no prazo e executa uma limpeza nativa a cada 15 minutos. O ciclo de vida R2 é uma segunda camada de remoção.

As franquias e cobranças da Cloudflare pertencem à conta do serviço. A cota do aplicativo limita os vídeos ativos da Cena, mas não constitui um teto de cobrança da conta nem limita o uso de outros projetos ou o volume de requisições.

## Conferência antes de distribuir os links

1. Entre em `/admin` com o e-mail autorizado.
2. Envie um MP4 de teste.
3. Crie um link de vídeo e outro do projeto inteiro.
4. Em um navegador sem sessão administrativa, confira o conteúdo de cada link.
5. Informe nome/e-mail, comente em um instante e responda ao comentário.
6. Confira na administração o comentário, o autor e o e-mail.
7. Encerre um dos links e confirme que ele perdeu o acesso.

O filme de demonstração não ocupa a cota. Arquivos excluídos mantêm os comentários no D1.
