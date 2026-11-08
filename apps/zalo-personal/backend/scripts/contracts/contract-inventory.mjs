import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import ts from 'typescript';

const backendRoot = path.resolve(import.meta.dirname, '../..');
const repoRoot = path.resolve(backendRoot, '..');
const frontendRoot = path.join(repoRoot, 'frontend');
const outputRoot = path.join(backendRoot, 'contracts/baseline');
const checkOnly = process.argv.includes('--check');

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const posix = (value) => value.split(path.sep).join('/');
const relativeToRepo = (value) => posix(path.relative(repoRoot, value));

function walk(root, predicate) {
  if (!fs.existsSync(root)) return [];
  const result = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'coverage', '.git'].includes(entry.name)) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...walk(full, predicate));
    else if (predicate(full)) result.push(full);
  }
  return result.sort();
}

const sourceFiles = [
  ...walk(path.join(backendRoot, 'src'), (file) => file.endsWith('.ts')),
  ...walk(path.join(frontendRoot, 'src'), (file) => file.endsWith('.ts') || file.endsWith('.vue')),
];
const testFiles = [
  ...walk(path.join(backendRoot, 'tests'), (file) => /\.(test|spec)\.ts$/.test(file)),
  ...walk(path.join(frontendRoot, 'src'), (file) => /\.(test|spec)\.ts$/.test(file)),
];
const testText = new Map(testFiles.map((file) => [relativeToRepo(file), fs.readFileSync(file, 'utf8')]));
const declaredEvidencePath = path.join(backendRoot, 'contracts/test-evidence.json');
const declaredEvidenceEntries = fs.existsSync(declaredEvidencePath)
  ? JSON.parse(fs.readFileSync(declaredEvidencePath, 'utf8')).entries
  : [];
const declaredEvidence = new Map(declaredEvidenceEntries.map((entry) => [`${entry.file}#${entry.symbol}`, entry.tests]));

function parsePrismaSchema() {
  const schemaPath = path.join(backendRoot, 'prisma/schema.prisma');
  const schema = fs.readFileSync(schemaPath, 'utf8').replace(/\r\n/g, '\n');
  const models = [];
  const enums = [];
  const blockPattern = /\b(model|enum)\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  for (const match of schema.matchAll(blockPattern)) {
    const [, kind, name, body] = match;
    const lines = body.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('//'));
    if (kind === 'enum') {
      enums.push({ name, values: lines.map((line) => line.split(/\s+/)[0]).filter(Boolean) });
      continue;
    }
    const fields = [];
    const attributes = [];
    for (const line of lines) {
      if (line.startsWith('@@')) {
        attributes.push(line);
        continue;
      }
      const fieldMatch = /^(\w+)\s+([^\s]+)(?:\s+([\s\S]+))?$/.exec(line);
      if (!fieldMatch) continue;
      const [, fieldName, rawType, rawAttributes = ''] = fieldMatch;
      const isList = rawType.endsWith('[]');
      const isOptional = rawType.endsWith('?');
      const type = rawType.replace(/\[\]$|\?$/g, '');
      fields.push({
        name: fieldName,
        type,
        nullable: isOptional,
        list: isList,
        id: /(?:^|\s)@id(?:\s|$)/.test(rawAttributes),
        unique: /(?:^|\s)@unique(?:\s|$)/.test(rawAttributes),
        default: rawAttributes.match(/@default\(([^)]*(?:\)[^)]*)?)\)/)?.[1] ?? null,
        relation: rawAttributes.match(/@relation\(([\s\S]+)\)/)?.[1] ?? null,
        attributes: rawAttributes.trim() || null,
      });
    }
    models.push({ name, fields, attributes });
  }
  models.sort((a, b) => a.name.localeCompare(b.name));
  enums.sort((a, b) => a.name.localeCompare(b.name));
  return {
    version: 1,
    source: 'backend/prisma/schema.prisma',
    schemaSha256: sha256(schema),
    modelCount: models.length,
    models,
    enums,
  };
}

function scriptKind(file) {
  return file.endsWith('.vue') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function parseSource(file) {
  const text = fs.readFileSync(file, 'utf8');
  return { text, source: ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file)) };
}

function buildStringConstants(source) {
  const constants = new Map();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer) constants.set(declaration.name.text, declaration.initializer);
    }
  }
  return constants;
}

function evalString(node, constants, seen = new Set()) {
  if (!node) return null;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isIdentifier(node)) {
    if (seen.has(node.text)) return null;
    const next = constants.get(node.text);
    return next ? evalString(next, constants, new Set([...seen, node.text])) : null;
  }
  if (ts.isParenthesizedExpression(node)) return evalString(node.expression, constants, seen);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = evalString(node.left, constants, seen);
    const right = evalString(node.right, constants, seen);
    return left !== null && right !== null ? left + right : null;
  }
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text;
    for (const span of node.templateSpans) {
      const expression = evalString(span.expression, constants, seen);
      value += expression ?? `\${${span.expression.getText()}}`;
      value += span.literal.text;
    }
    return value;
  }
  return null;
}

function lineOf(source, node) {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function evidenceFor(symbol) {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matcher = new RegExp(`\\b${escaped}\\b`);
  return [...testText.entries()].filter(([, text]) => matcher.test(text)).map(([file]) => file).sort();
}

function riskFor(name, file) {
  const value = `${name} ${file}`.toLowerCase();
  if (/(auth|session|token|privacy|message|socket|zalo|friend|contact|storage|upload|worker|cron|tenant|rbac|grant)/.test(value)) return 'P0';
  if (/(service|route|repository|sync|merge|automation|webhook|report|group|pipeline)/.test(value)) return 'P1';
  return 'P2';
}

function inventoryTypeScript() {
  const routes = [];
  const sockets = [];
  const objects = [];
  const functions = [];

  for (const file of sourceFiles) {
    const rel = relativeToRepo(file);
    const { text, source } = parseSource(file);
    const constants = buildStringConstants(source);
    const exportedClasses = new Set();

    const visit = (node) => {
      if (ts.isClassDeclaration(node) && node.name && node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
        exportedClasses.add(node.name.text);
        objects.push({ kind: 'class', name: node.name.text, file: rel, line: lineOf(source, node) });
      }
      if ((ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) && node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
        objects.push({
          kind: ts.isInterfaceDeclaration(node) ? 'interface' : ts.isTypeAliasDeclaration(node) ? 'type' : 'enum',
          name: node.name.text,
          file: rel,
          line: lineOf(source, node),
          signatureSha256: sha256(node.getText(source).replace(/\s+/g, ' ').trim()),
        });
      }

      let functionName = null;
      let exported = false;
      let kind = null;
      if (ts.isFunctionDeclaration(node) && node.name) {
        functionName = node.name.text;
        exported = Boolean(node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
        kind = 'function';
      } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
        functionName = node.name.text;
        const statement = node.parent?.parent;
        exported = Boolean(statement && ts.isVariableStatement(statement) && statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
        kind = 'callable';
      } else if (ts.isMethodDeclaration(node) && node.name) {
        const parentName = ts.isClassDeclaration(node.parent) ? node.parent.name?.text : undefined;
        functionName = `${parentName ?? 'anonymous'}.${node.name.getText(source)}`;
        exported = Boolean(parentName && exportedClasses.has(parentName));
        kind = 'method';
      }
      if (functionName) {
        const declaredTests = declaredEvidence.get(`${rel}#${functionName}`) ?? [];
        const evidence = [...new Set([...evidenceFor(functionName.split('.').at(-1)), ...declaredTests])].sort();
        functions.push({
          symbol: functionName,
          kind,
          exported,
          file: rel,
          line: lineOf(source, node),
          risk: riskFor(functionName, rel),
          sideEffects: /(prisma\.|\.emit\(|\.send\(|\.publish\(|\.add\(|fetch\(|axios\.|zaloOps\.)/.test(node.getText(source)),
          evidence,
          status: declaredTests.length > 0 ? 'FULL' : evidence.length > 0 ? 'PARTIAL' : 'UNTESTED',
        });
      }

      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text.toLowerCase();
        const firstArg = node.arguments[0];
        if (['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(method)) {
          const routePath = evalString(firstArg, constants);
          if (routePath?.startsWith('/')) {
            const callText = node.getText(source);
            const receiver = node.expression.expression.getText(source);
            const producer = rel.startsWith('backend/') && /^(?:app|server|fastify|router)$/.test(receiver);
            const consumer = rel.startsWith('frontend/') && /(?:api|axios|http|client)/i.test(receiver);
            if (!producer && !consumer) {
              ts.forEachChild(node, visit);
              return;
            }
            routes.push({
              method: method.toUpperCase(),
              path: routePath,
              role: producer ? 'producer' : 'consumer',
              receiver,
              file: rel,
              line: lineOf(source, node),
              authOrPreHandler: /authMiddleware|preHandler|requireGrant|requireZaloAccess|verifyApiKey/.test(callText)
                || (producer && /addHook\(['"]preHandler['"]|authMiddleware/.test(text)),
              statuses: [...callText.matchAll(/\.status\((\d{3})\)/g)].map((match) => Number(match[1])).filter((value, index, all) => all.indexOf(value) === index).sort(),
            });
          }
        }
        if (['emit', 'on', 'once'].includes(method)) {
          const event = evalString(firstArg, constants);
          if (event) {
            const target = node.expression.expression.getText(source);
            const roomMatch = target.match(/\.to\(([^)]+)\)$/);
            sockets.push({
              event,
              operation: method,
              direction: rel.startsWith('frontend/') ? (method === 'emit' ? 'client-to-server' : 'server-to-client') : (method === 'emit' ? 'server-to-client' : 'client-to-server'),
              room: roomMatch?.[1] ?? null,
              file: rel,
              line: lineOf(source, node),
              payloadExpression: node.arguments[1]?.getText(source).slice(0, 240) ?? null,
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);

    for (const match of text.matchAll(/\bz\.object\s*\(\s*\{/g)) {
      objects.push({ kind: 'zod-object', name: `anonymous@${source.getLineAndCharacterOfPosition(match.index).line + 1}`, file: rel, line: source.getLineAndCharacterOfPosition(match.index).line + 1 });
    }
  }

  const unique = (items, key) => [...new Map(items.map((item) => [key(item), item])).values()];
  return {
    routes: unique(routes, (item) => `${item.method}:${item.path}:${item.file}:${item.line}`).sort((a, b) => `${a.path}:${a.method}:${a.file}:${a.line}`.localeCompare(`${b.path}:${b.method}:${b.file}:${b.line}`)),
    sockets: unique(sockets, (item) => `${item.event}:${item.operation}:${item.file}:${item.line}`).sort((a, b) => `${a.event}:${a.file}:${a.line}`.localeCompare(`${b.event}:${b.file}:${b.line}`)),
    objects: unique(objects, (item) => `${item.kind}:${item.name}:${item.file}:${item.line}`).sort((a, b) => `${a.name}:${a.file}:${a.line}`.localeCompare(`${b.name}:${b.file}:${b.line}`)),
    functions: unique(functions, (item) => `${item.symbol}:${item.file}:${item.line}`).sort((a, b) => `${a.file}:${a.line}:${a.symbol}`.localeCompare(`${b.file}:${b.line}:${b.symbol}`)),
  };
}

function scenarioCatalog() {
  const scenarios = [
    ['account-session', ['account', 'session', 'qr', 'ghost', 'refresh-token']],
    ['inbound-outbound-message', ['chat', 'message', 'aggregate', 'listener']],
    ['media-storage-antivirus', ['media', 'attachment', 'storage', 'clamav', 'upload']],
    ['friend-contact-identity', ['friend', 'contact', 'duplicate', 'merge']],
    ['group-membership', ['group', 'member', 'poll']],
    ['automation-worker-cron', ['automation', 'worker', 'cron', 'sync']],
    ['auth-rbac-privacy-tenancy', ['auth', 'rbac', 'privacy', 'tenant', 'security']],
    ['retry-restart-idempotency', ['retry', 'reconnect', 'idempot', 'dedup', 'recovery']],
    ['frontend-api-socket-state', ['frontend', 'socket', 'composable', 'store']],
  ];
  return scenarios.map(([id, keywords]) => {
    const evidence = [...testText.keys()].filter((file) => keywords.some((keyword) => file.toLowerCase().includes(keyword))).sort();
    return { id, risk: 'P0', evidence, status: evidence.length ? 'PARTIAL' : 'UNTESTED' };
  });
}

function baselineMetadata(database) {
  const packageLocks = [path.join(repoRoot, 'package-lock.json'), path.join(backendRoot, 'package-lock.json'), path.join(frontendRoot, 'package-lock.json')]
    .filter(fs.existsSync)
    .map((file) => ({ file: relativeToRepo(file), sha256: sha256(fs.readFileSync(file)) }));
  return {
    version: 2,
    sourceCommit: process.env.ZALOCRM_BASELINE_COMMIT || 'c03c03245a1010d1e279d0548edc5b1f568f3a9e',
    schemaSha256: database.schemaSha256,
    packageLocks,
  };
}

const database = parsePrismaSchema();
if (database.modelCount < 108) throw new Error(`Expected at least 108 Prisma models, found ${database.modelCount}`);
const inventory = inventoryTypeScript();
const inventoryKeys = new Set(inventory.functions.map((entry) => `${entry.file}#${entry.symbol}`));
const staleEvidence = [...declaredEvidence.keys()].filter((key) => !inventoryKeys.has(key));
if (staleEvidence.length) throw new Error(`Stale function test evidence:\n${staleEvidence.join('\n')}`);
const outputs = {
  'baseline-metadata.json': baselineMetadata(database),
  'database-contract.json': database,
  'rest-contract.json': {
    version: 1,
    routeCount: inventory.routes.length,
    producerCount: inventory.routes.filter((route) => route.role === 'producer').length,
    consumerCount: inventory.routes.filter((route) => route.role === 'consumer').length,
    routes: inventory.routes,
  },
  'socket-contract.json': { version: 1, eventUseCount: inventory.sockets.length, events: inventory.sockets },
  'object-contract.json': { version: 1, objectCount: inventory.objects.length, objects: inventory.objects },
  'function-test-map.json': { version: 1, functionCount: inventory.functions.length, functions: inventory.functions },
  'scenario-catalog.json': { version: 1, scenarios: scenarioCatalog() },
};

fs.mkdirSync(outputRoot, { recursive: true });
let drift = false;
for (const [name, value] of Object.entries(outputs)) {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  const target = path.join(outputRoot, name);
  if (checkOnly) {
    if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== content) {
      console.error(`Contract drift: ${relativeToRepo(target)}. Run npm run contracts:generate.`);
      drift = true;
    }
  } else {
    fs.writeFileSync(target, content);
    console.log(`Wrote ${relativeToRepo(target)}`);
  }
}
if (drift) process.exitCode = 1;
else console.log(`Contracts OK: ${database.modelCount} models, ${inventory.routes.length} routes, ${inventory.sockets.length} socket uses, ${inventory.objects.length} objects, ${inventory.functions.length} functions.`);
