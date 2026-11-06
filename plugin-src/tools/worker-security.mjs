import ts from 'typescript';
/** Inspect executable syntax, excluding documentation and strings. */
export function workerViolations(source) {
  const file = ts.createSourceFile('worker.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const banned = new Set(['fetch', 'XMLHttpRequest', 'WebSocket', 'importScripts', 'eval', 'Function', 'require']);
  const hits = [];
  const visit = node => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const expression = node.expression;
      const name = ts.isIdentifier(expression) ? expression.text : ts.isPropertyAccessExpression(expression) ? expression.name.text : '';
      if (banned.has(name)) hits.push(node.getText(file).slice(0, 80));
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      if (ts.isIdentifier(node.expression) && ['document', 'localStorage', 'indexedDB', 'navigator'].includes(node.expression.text)) hits.push(node.getText(file).slice(0, 80));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return hits;
}
