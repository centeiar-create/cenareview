# Cena — revisão de vídeo

Versão independente para Cloudflare Workers, R2 e D1. Reaproveita a interface da Cena e remove a dependência do login OpenAI. Publicada em [cenareview.centeiar.workers.dev](https://cenareview.centeiar.workers.dev/admin), com publicação automática a partir de `main`. A administração exige Cloudflare Access.

## Fluxo de revisão

- A administração cria um link de **um vídeo** ou do **projeto inteiro**. O link de projeto inclui os próximos vídeos adicionados ao mesmo projeto.
- Quem recebe o link pode assistir e ler os comentários. Para comentar ou responder, informa **nome e e-mail**, sem conta, senha ou código por e-mail.
- O nome aparece na revisão. O e-mail é visível apenas na administração. Nome e e-mail são declarados pelo revisor, sem confirmação de propriedade do endereço.
- Comentários podem apontar um momento, um trecho ou o vídeo inteiro. Revisores podem editar seus próprios comentários e responder aos demais. Upload, conclusão dos ajustes, aprovação, exportação e gestão dos links ficam com a administração.
- O responsável escolhe a validade do link (7, 30 ou 90 dias na interface) e pode encerrá-lo. Encerrar o link bloqueia também as sessões de quem já o abriu e as próximas requisições do player. Dados já baixados pelo navegador não podem ser recolhidos.
- Os links usam 256 bits aleatórios. O banco guarda somente seus hashes. O link completo é exibido na criação para ser copiado.

## Armazenamento e retenção

Limites iniciais: **1 GB no espaço administrativo, até 100 MB por arquivo e 200 arquivos ativos**, com vídeos MP4, WebM ou MOV. Não há transcodificação: prefira MP4 H.264/AAC.

Cada arquivo expira **30 dias após o início do envio**. O servidor bloqueia sua reprodução no prazo, e uma tarefa nativa do Worker, a cada 15 minutos, exclui até 20 arquivos expirados e libera a cota. Em lotes grandes, a remoção física ocorre nas execuções seguintes. Projetos, comentários, respostas e aprovações permanecem no D1. Revogar um link não exclui arquivos nem comentários.

Configure também uma regra de ciclo de vida no bucket R2 para excluir objetos com o prefixo `review-videos/` após 30 dias. Ela é uma segunda camada de limpeza; a indisponibilidade no prazo é garantida pelo aplicativo. A regra de R2 costuma remover objetos até 24 horas após a expiração, conforme a [documentação oficial](https://developers.cloudflare.com/r2/buckets/object-lifecycles/).

O bucket permanece privado: não habilite domínio público nem `r2.dev`. Tanto o player administrativo quanto o compartilhado leem os bytes através de rotas autorizadas, com suporte a HTTP Range. Não coloque os vídeos na pasta `public/`.

## Publicação na Cloudflare

Consulte também [PUBLICACAO.md](./PUBLICACAO.md) para a publicação pelo GitHub com Workers Builds. As variáveis administrativas ficam no painel Cloudflare; `keep_vars: true` evita que novas publicações as apaguem.

Requer Node 22.13+ e uma conta Cloudflare com Workers, D1, R2 e Access habilitados. Não há chaves nem credenciais neste pacote.

1. Execute `npm ci` e `npx wrangler login`.
2. Crie os recursos: `npx wrangler d1 create cena-revisao` e `npx wrangler r2 bucket create cena-revisao-videos`.
3. Copie o `database_id` retornado para `wrangler.jsonc` e confira os nomes dos recursos. Não compartilhe o bucket com outro aplicativo, pois a limpeza atua sobre os registros deste banco.
4. No Cloudflare Access, crie uma aplicação **self-hosted com proteção por caminho**, cobrindo `/admin`, `/admin/*` e `/api/admin/*` no domínio escolhido. Autorize somente seu e-mail. É possível usar o PIN por e-mail da Cloudflare para a administração. Os revisores não passam por esse fluxo.
5. Preencha `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` e `OWNER_EMAIL` em **Workers → cenareview → Settings → Variables and Secrets**. Não declare valores vazios para elas no repositório. Domínio de equipe e AUD vêm da aplicação Access. **Não proteja o Worker inteiro nem os caminhos `/r/*` e `/api/review/*`**, pois isso exigiria login dos revisores. As APIs de revisão validam seus próprios links.
6. Execute `npm run db:migrate`, `npm run check`, `npm test` e `npm run build`.
7. Execute `npm run deploy`. Só então conecte o domínio desejado em Workers → Settings → Domains & Routes, conferindo que os caminhos administrativos desse domínio estão incluídos na aplicação Access.
8. Configure o ciclo de vida R2 descrito acima. No Worker, confirme a tarefa Cron `*/15 * * * *`.
9. Abra `/admin`, crie o projeto e teste um link `/r/...` em uma janela sem sessão administrativa. Teste ambos os escopos, um comentário e a revogação antes de distribuir links reais.

O script de publicação recusa um banco D1 sem identificador válido. O Worker também recusa acesso administrativo quando o Access não foi configurado. A aplicação verifica a assinatura RS256 do JWT, emissor, audiência, validade e e-mail autorizado; não confia em cabeçalhos de identidade enviados pelo visitante.

Para trabalhar localmente, `npm run dev`. A administração continua exigindo um JWT Access válido; não existe senha de desenvolvimento nem bypass de autenticação no código publicado. Os testes automatizados usam chaves RSA temporárias e serviços isolados, sem dados reais.

## Migração da versão anterior

A versão anterior hospedada no ChatGPT permanece independente, com seus próprios banco, arquivos, URL e limpeza. Este pacote não a altera. Criar recursos novos na sua Cloudflare **não transfere automaticamente os vídeos nem as revisões anteriores**.

Se houver dados reais na versão anterior, copie o D1 e os objetos R2 por acesso administrativo autorizado, preserve os `mediaId`, `object_key`, `created_at` e `expires_at`, e mapeie o proprietário antigo para `cena-owner`. Não renove o prazo dos arquivos ao copiá-los. O JSON exportado pela interface contém os comentários, mas não os bytes dos vídeos. Não encerre a hospedagem ou a rotina de limpeza antiga antes de verificar a transferência. Sem dados anteriores, comece com o espaço novo.

## Código e verificação

- `worker.ts`: rotas públicas e administrativas, arquivos estáticos e Cron.
- `lib/access.ts`: autenticação administrativa com validação de JWT Access.
- `lib/sharing.ts`: escopos, links revogáveis, identificação, cookies, comentários e respostas.
- `lib/workspace.ts`: gravação com revisão otimista e combinação de mudanças independentes. Comentários simultâneos são preservados. Alterações conflitantes no mesmo campo retornam erro para conferência.
- `lib/review-store.ts`: cota, reservas de upload, retenção e remoção de arquivos.
- `public/`: interfaces administrativas e de revisão, estilos e filme de demonstração.
- `drizzle/`: migrações SQL. A migração inicial foi preservada; o compartilhamento está na segunda migração.
- `tests/sharing.mjs`: testes de integração em D1/R2 isolados e validação real de assinatura RSA. Cobre escopos, tentativas de acesso indevido, identificação, privacidade de e-mail, comentários e respostas simultâneos, repetição de envios, revogação, expiração e limpeza.

Referências: [Access por caminho](https://developers.cloudflare.com/workers/configuration/cloudflare-access/), [validação de JWT](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/) e [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/).

Verificação da publicação: TypeScript e sintaxe JavaScript aprovados; **18 cenários de integração passaram localmente e no Workers Builds**; publicação concluída com D1, R2 e Cron de 15 minutos. Em HTTPS, foram conferidos a entrada administrativa pelo Access, os links de projeto e de um vídeo, identificação sem conta, comentário em **5,160 segundos**, resposta, sincronização com a administração, privacidade do e-mail e revogação do link. O envio de arquivo em produção aguarda uma conferência manual: a extensão do navegador bloqueou a seleção automática de arquivos locais. Upload e retenção foram verificados nos testes isolados.
