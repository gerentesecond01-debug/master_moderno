# NEXUS Wake Prim

1. Crie `prim.json` e `agents.json` na branch `main` do repositório público `gerentesecond01-debug/prim`, usando os arquivos fornecidos.
2. No Render do MASTER, configure `GITHUB_TOKEN` (token novo Fine-grained, apenas este repositório, Contents read/write) e `MASTER_SECRET` (segredo aleatório longo).
3. No script `NEXUS_WAKE_PRIM.lsl`, configure o mesmo `MASTER_SECRET` e um token novo com acesso ao mesmo repositório.
4. Coloque o script em um único prim, em região com scripts permitidos.
5. Confira o `prim.json` no GitHub. Ao cadastrar/aprovar/editar/remover Agents, o Master atualiza `agents.json`.
6. O Master consulta `prim.json` somente quando precisa acordar um Agent. O prim consulta `agents.json` somente ao receber o comando. Sem pings periódicos.

**Segurança:** revogue o token exposto anteriormente. A técnica de autenticação do GitHub via token embutido na URL é mantida a pedido, mas não é garantida e pode retornar 401/403; nesse caso será necessário usar um intermediário com autenticação adequada. Não publique segredos em JSON.

**Limitações:** O Master mantém fallback de ping direto. O prim confirma apenas o envio da tentativa, não que o Agent esteja pronto. As alterações não foram testadas em uma região Second Life real nem no Render.
