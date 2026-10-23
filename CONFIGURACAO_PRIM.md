# NEXUS Wake Prim

1. Crie `prim.json` e `agents.json` na branch `main` do repositório público `gerentesecond01-debug/prim`, usando os arquivos fornecidos.
2. No Render do MASTER, configure `GITHUB_TOKEN` (token novo Fine-grained, apenas este repositório, Contents read/write) e `MASTER_SECRET` (segredo aleatório longo).
3. No script `NEXUS_WAKE_PRIM.lsl`, configure o mesmo `MASTER_SECRET` e um token novo com acesso ao mesmo repositório.
4. Coloque o script em um único prim, em região com scripts permitidos.
5. Confira o `prim.json` no GitHub. Ao cadastrar/aprovar/editar/remover Agents, o Master atualiza `agents.json`.
6. O Master consulta `prim.json` somente quando precisa acordar um Agent. O prim consulta `agents.json` somente ao receber o comando. Sem pings periódicos.

**Segurança:** revogue o token exposto anteriormente. A técnica de autenticação do GitHub via token embutido na URL é mantida a pedido, mas não é garantida e pode retornar 401/403; nesse caso será necessário usar um intermediário com autenticação adequada. Não publique segredos em JSON.

**Limitações:** O Master mantém fallback de ping direto. O prim confirma apenas o envio da tentativa, não que o Agent esteja pronto. As alterações não foram testadas em uma região Second Life real nem no Render.

## Correção de diagnóstico (20/10/2026)
- O Master registra em logs: consulta a `prim.json`, POST ao prim, status HTTP recebido e verificação `/health` do Agent.
- Resposta HTTP 202 do prim **não** significa que o Agent está online. O Master agora aguarda `/health` antes de iniciar o bot.
- A reconexão automática após falha tem intervalo mínimo de 15 minutos para não repetir ciclos de três tentativas continuamente. A ação manual continua disponível.
- Se aparecer `MASTER_SECRET ausente ou com menos de 20 caracteres`, configure no Render o mesmo segredo longo usado no script LSL.
- Se aparecer `GitHub prim.json HTTP 404`, confira se `prim.json` existe no repositório `gerentesecond01-debug/prim` na branch `main`.
- Se aparecer `Prim não está marcado como online`, confira o registro do prim e o texto flutuante no Second Life.
- Se aparecer `HTTP 403`, confira o segredo. Se aparecer `HTTP 429`, o prim já está processando outro comando.
- Se o prim retornar `LOOKUP_STARTED`, mas o Agent não acordar, verifique no chat do proprietário do prim mensagens `NEXUS agents.json` e `NEXUS: despertar ... respondeu HTTP ...`.

## Ajuste de recuperação (20/10/2026)
- O botão Ligar tenta GET /health diretamente no Agent (até 12 s). Se não responder, solicita o despertar ao prim e verifica /health (até 35 s). São no máximo 3 ciclos com pausa de 10 s, sem acordar outros Agents.
- O Watchdog também tenta HTTP direto antes do prim.
- Uma conexão automática já em andamento continua protegida contra duplicação. O botão Ligar informa o motivo do bloqueio temporário; a operação o libera ao finalizar. Não há desbloqueio forçado que poderia duplicar processos.
- O retorno `LOOKUP_STARTED` do prim não garante que o prim conseguiu consultar agents.json ou enviar GET ao Agent; verifique as mensagens do proprietário do prim.
