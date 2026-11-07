import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import Fastify from 'fastify';

type PluginEntry = { exportName: string; modulePath: string; prefix: string };
type RouteEntry = { method: string; path: string; owner: string };

const backendRoot = path.resolve(import.meta.dirname, '../..');
const appPath = path.join(backendRoot, 'src/app.ts');
const outputPath = path.join(backendRoot, 'contracts/baseline/runtime-rest-contract.json');
// Imports must initialize the same Community modules as production, but route
// discovery never opens a database connection or processes a request.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://contract:contract@127.0.0.1:5432/contract_inventory';
process.env.REDIS_URL ??= 'redis://127.0.0.1:6379/15';
const appText = fs.readFileSync(appPath, 'utf8');
const source = ts.createSourceFile(appPath, appText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

const imports = new Map<string, string>();
for (const statement of source.statements) {
  if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
  const modulePath = statement.moduleSpecifier.text;
  const bindings = statement.importClause?.namedBindings;
  if (bindings && ts.isNamedImports(bindings)) {
    for (const element of bindings.elements) imports.set(element.name.text, modulePath);
  }
}

function stringValue(node: ts.Expression | undefined): string | null {
  if (!node) return null;
  if (ts.isStringLiteralLike(node)) return node.text;
  return null;
}

// Capture lazily imported Community route registrars from app.ts as runtime owners too.
function discoverDynamicImports(node: ts.Node): void {
  if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer) {
    const initializer = ts.isAwaitExpression(node.initializer) ? node.initializer.expression : node.initializer;
    if (ts.isCallExpression(initializer) && initializer.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const modulePath = stringValue(initializer.arguments[0]);
      if (modulePath) {
        for (const element of node.name.elements) {
          if (ts.isIdentifier(element.name)) imports.set(element.name.text, modulePath);
        }
      }
    }
  }
  ts.forEachChild(node, discoverDynamicImports);
}
discoverDynamicImports(source);

const plugins: PluginEntry[] = [];
const appRoutes: RouteEntry[] = [];
function discoverRegistrations(node: ts.Node): void {
  if (ts.isCallExpression(node)) {
    if (ts.isPropertyAccessExpression(node.expression) && node.expression.expression.getText(source) === 'app') {
      const method = node.expression.name.text;
      if (method === 'register' && ts.isIdentifier(node.arguments[0])) {
        const exportName = node.arguments[0].text;
        const modulePath = imports.get(exportName);
        if (modulePath?.startsWith('./')) {
          let prefix = '';
          const options = node.arguments[1];
          if (options && ts.isObjectLiteralExpression(options)) {
            const property = options.properties.find((item): item is ts.PropertyAssignment =>
              ts.isPropertyAssignment(item) && item.name.getText(source) === 'prefix');
            prefix = property ? stringValue(property.initializer) ?? '' : '';
          }
          plugins.push({ exportName, modulePath, prefix });
        }
      } else if (['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(method)) {
        const routePath = stringValue(node.arguments[0]);
        if (routePath) appRoutes.push({ method: method.toUpperCase(), path: routePath, owner: 'backend/src/app.ts' });
      }
    } else if (ts.isIdentifier(node.expression) && node.arguments[0]?.getText(source) === 'app') {
      const exportName = node.expression.text;
      const modulePath = imports.get(exportName);
      if (modulePath?.startsWith('./')) plugins.push({ exportName, modulePath, prefix: '' });
    }
  }
  ts.forEachChild(node, discoverRegistrations);
}
discoverRegistrations(source);

function joinRoute(prefix: string, routePath: string): string {
  const combined = `${prefix}/${routePath}`.replace(/\/{2,}/g, '/');
  return combined.length > 1 && combined.endsWith('/') ? combined.slice(0, -1) : combined;
}

const routes: RouteEntry[] = [...appRoutes];
const failures: Array<{ owner: string; error: string }> = [];

function createRecorder(owner: string, prefix = ''): any {
  let proxy: any;
  const routeMethod = (method: string) => (routePath: string | string[]) => {
    for (const value of Array.isArray(routePath) ? routePath : [routePath]) {
      if (typeof value === 'string') routes.push({ method, path: joinRoute(prefix, value), owner });
    }
    return proxy;
  };
  const target: Record<string, unknown> = {
    get: routeMethod('GET'),
    post: routeMethod('POST'),
    put: routeMethod('PUT'),
    patch: routeMethod('PATCH'),
    delete: routeMethod('DELETE'),
    head: routeMethod('HEAD'),
    options: routeMethod('OPTIONS'),
    route: (options: { method?: string | string[]; url?: string }) => {
      const methods = Array.isArray(options?.method) ? options.method : [options?.method ?? 'GET'];
      if (options?.url) for (const method of methods) routes.push({ method: String(method).toUpperCase(), path: joinRoute(prefix, options.url), owner });
      return proxy;
    },
    register: async (plugin: unknown, options?: { prefix?: string }) => {
      if (typeof plugin === 'function') await plugin(createRecorder(owner, joinRoute(prefix, options?.prefix ?? '')));
      return proxy;
    },
    addHook: () => proxy,
    decorate: () => proxy,
    decorateRequest: () => proxy,
    decorateReply: () => proxy,
    setErrorHandler: () => proxy,
    setNotFoundHandler: () => proxy,
    hasDecorator: () => false,
    withTypeProvider: () => proxy,
    server: {},
    io: { to: () => ({ emit: () => undefined }), emit: () => undefined },
    jwt: { sign: () => '', verify: () => ({}) },
    log: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
  };
  proxy = new Proxy(target, {
    get(object, property) {
      if (property in object) return object[property as string];
      return () => proxy;
    },
  });
  return proxy;
}

for (const entry of [...new Map(plugins.map((plugin) => [`${plugin.modulePath}:${plugin.exportName}:${plugin.prefix}`, plugin])).values()]) {
  const sourcePath = path.resolve(path.dirname(appPath), entry.modulePath.replace(/\.js$/, '.ts'));
  const owner = path.relative(path.resolve(backendRoot, '..'), sourcePath).split(path.sep).join('/');
  const app = Fastify({ logger: false });
  try {
    const module = await import(pathToFileURL(sourcePath).href);
    const plugin = module[entry.exportName];
    if (typeof plugin !== 'function') throw new Error(`Export ${entry.exportName} is not a function`);
    app.addHook('onRoute', (options) => {
      const methods = Array.isArray(options.method) ? options.method : [options.method];
      for (const method of methods) routes.push({ method: String(method).toUpperCase(), path: options.url, owner });
    });
    await app.register(plugin, entry.prefix ? { prefix: entry.prefix } : undefined);
    await app.ready();
  } catch (error) {
    failures.push({ owner: `${owner}#${entry.exportName}`, error: error instanceof Error ? error.message : String(error) });
  } finally {
    await app.close().catch(() => undefined);
  }
}

const dedupedRoutes = [...new Map(routes.map((route) => [`${route.method}:${route.path}:${route.owner}`, route])).values()]
  .sort((a, b) => `${a.path}:${a.method}:${a.owner}`.localeCompare(`${b.path}:${b.method}:${b.owner}`));
const contract = { version: 1, routeCount: dedupedRoutes.length, routes: dedupedRoutes, failures };
const content = `${JSON.stringify(contract, null, 2)}\n`;
if (process.argv.includes('--check')) {
  if (!fs.existsSync(outputPath) || fs.readFileSync(outputPath, 'utf8') !== content) {
    console.error('Runtime route contract drift. Run npm run contracts:generate.');
    process.exitCode = 1;
  }
} else {
  fs.writeFileSync(outputPath, content);
}
console.log(`Runtime routes: ${dedupedRoutes.length}; failures: ${failures.length}`);
if (failures.length) {
  for (const failure of failures) console.error(`${failure.owner}: ${failure.error}`);
  process.exitCode = 1;
}
