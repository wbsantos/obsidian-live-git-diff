# Live Git Diff — versão local 0.2.1

Compara uma nota com um commit Git fixo e permite editar a versão atual no Live Preview nativo do Obsidian. A versão antiga aparece renderizada, em somente leitura. A comparação atualiza após 300 ms de pausa na digitação e invalida destaques antigos imediatamente.

## Uso

1. Reative o plugin após atualizar seus arquivos.
2. Abra uma nota Markdown rastreada pelo Git.
3. Execute **Live Git Diff: Open review against a version…** e escolha o commit.
4. Edite a nota normalmente. Desfazer, refazer, seleção e cursor continuam nativos.

**Open git diff review for this file** usa a referência configurada, HEAD por padrão. **Refresh review (re-pin the base version)** troca explicitamente a referência. Alterações comuns e salvamentos mantêm o commit escolhido. **Close review** remove os destaques e fecha o painel. O modo de leitura continua disponível.

A igualdade preserva caixa, código, hierarquia, formatação efetiva e destinos de links. Delimitadores equivalentes, entidades e espaços sem efeito visual são ignorados. A configuração de quebras de linha do vault é respeitada. Propriedades e sintaxes não interpretadas recebem indicação de comparação conservadora. Em tabelas e widgets nativos, a margem indica alterações quando o interior não pode ser decorado pela API pública.

Listas recebem destaques por item, incluindo suas continuações; itens preservados ficam sem cor. Código inline recebe marcação por palavra nos dois painéis de leitura. Fora de uma revisão, a extensão não reserva espaço para indicadores no editor.

## Desenvolvimento

```powershell
cd plugin-src
npm ci --ignore-scripts
npm run ci
```

A distribuição é gerada em `plugin-dist` com três arquivos: `main.js`, `manifest.json` e `styles.css`. O Web Worker é auditado antes de ser incorporado ao bundle. `npm run dev` acompanha os fontes, inclusive os do worker. Os testes usam Node 22.6 ou posterior; a entrega foi verificada com Node 24.13.0 e Obsidian 1.15.0 no Windows.

O código de execução não escreve conteúdo de notas. As transações no editor contêm apenas efeitos de apresentação e rolagem; quem edita e salva é o Obsidian. Configurações próprias são persistidas em `data.json`. A análise ocorre em um worker com operações de diff limitadas, e a versão histórica é analisada e renderizada novamente apenas quando necessário.

Documentos muito grandes têm custo perceptível na primeira renderização histórica; o ensaio de 882 mil caracteres levou cerca de 15 segundos no aplicativo. Resultados que excedem o orçamento de detalhamento continuam marcados como alterados. Blocos movidos não recebem categoria especial. A versão histórica não reproduz o Live Preview e conteúdo dinâmico de plugins não define igualdade.

Veja o [relatório de implementação e validação](LOCAL-REVIEW.md), com 154 testes, e o [relatório da correção 0.2.1](FIX-HIGHLIGHTS-0.2.1.md), com a reprodução da nota real, medidas de largura e localização do backup. A versão anterior da documentação está em [README-0.1.1.md](README-0.1.1.md).
