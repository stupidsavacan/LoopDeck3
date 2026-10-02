import path from 'node:path';
import process from 'node:process';
import ts from 'typescript';

const repoRoot = process.cwd();
const tsconfigPath = path.join(repoRoot, 'tsconfig.json');
const srcRoot = path.join(repoRoot, 'src');
const lowerAreas = new Set(['core', 'storage', 'packs', 'pdf', 'ui']);

// Screens compose shared quiz and library helpers. Other cross-screen imports
// must move to an owned shared module or have an explicit narrow justification.
const screenImportAllowlist = new Map([
  ['src/screens/homeScreen.ts -> src/screens/homeFolders.ts', 'home-only helper currently colocated under screens'],
  ['src/screens/moduleScreen.ts -> src/screens/inlineQuiz.ts', 'deliberate composition of the shared inline quiz renderer'],
  ['src/screens/reviewCenter.ts -> src/screens/inlineQuiz.ts', 'deliberate composition of the shared inline quiz renderer']
]);

function fail(message) {
  console.error(`[architecture] ${message}`);
  process.exitCode = 1;
}

function normalize(fileName) {
  return path.resolve(fileName);
}

function repoPath(fileName) {
  return path.relative(repoRoot, fileName).split(path.sep).join('/');
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function isProductionTs(fileName) {
  const resolved = normalize(fileName);
  return isWithin(srcRoot, resolved) && /\.(?:[cm]?ts|tsx)$/.test(resolved) && !resolved.endsWith('.d.ts');
}

function areaOf(fileName) {
  const relative = repoPath(fileName);
  if (relative === 'src/main.ts') return 'main';
  const match = /^src\/([^/]+)\//.exec(relative);
  return match?.[1] ?? 'other';
}

function collectSpecifiers(sourceFile) {
  const specifiers = [];

  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression
      && ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      specifiers.push(node.moduleReference.expression.text);
    } else if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1
      && ts.isStringLiteralLike(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return specifiers;
}

const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
if (configFile.error) {
  fail(`cannot read tsconfig.json: ${ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n')}`);
  process.exit();
}

const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, repoRoot, undefined, tsconfigPath);
if (parsed.errors.length) {
  for (const error of parsed.errors) {
    fail(`tsconfig error: ${ts.flattenDiagnosticMessageText(error.messageText, '\n')}`);
  }
  process.exit();
}

const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
const sourceFiles = program.getSourceFiles()
  .filter((sourceFile) => isProductionTs(sourceFile.fileName))
  .sort((a, b) => repoPath(a.fileName).localeCompare(repoPath(b.fileName)));
const productionFiles = new Set(sourceFiles.map((sourceFile) => normalize(sourceFile.fileName)));
const resolutionCache = ts.createModuleResolutionCache(repoRoot, (fileName) => fileName, parsed.options);
const graph = new Map(sourceFiles.map((sourceFile) => [normalize(sourceFile.fileName), new Set()]));

for (const sourceFile of sourceFiles) {
  const source = normalize(sourceFile.fileName);
  for (const specifier of collectSpecifiers(sourceFile)) {
    const resolution = ts.resolveModuleName(specifier, source, parsed.options, ts.sys, resolutionCache).resolvedModule;
    if (!resolution) continue;

    const target = normalize(resolution.resolvedFileName);
    if (productionFiles.has(target)) graph.get(source).add(target);
  }
}

const errors = [];
for (const source of sourceFiles) {
  if (areaOf(source.fileName) === 'app') continue;
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!statement.moduleSpecifier.text.endsWith('/studyRepository')) continue;
    const bindings = statement.importClause?.namedBindings;
    const importsSingleton = bindings && (ts.isNamespaceImport(bindings) || bindings.elements.some(element => (element.propertyName ?? element.name).text === 'studyStore'));
    if (importsSingleton) errors.push('global repository dependency: ' + repoPath(source.fileName) + '\n  Receive the repository from the application context instead.');
  }
}

for (const [source, targets] of graph) {
  for (const target of targets) {
    const sourceArea = areaOf(source);
    const targetArea = areaOf(target);
    const edge = `${repoPath(source)} -> ${repoPath(target)}`;

    if (lowerAreas.has(sourceArea) && (targetArea === 'screens' || targetArea === 'main' || targetArea === 'app')) {
      errors.push(`reverse dependency: ${edge}\n  ${sourceArea} is reusable/lower-level and must not depend on ${targetArea}`);
    }

    if (sourceArea === 'screens' && targetArea === 'screens' && source !== target && !screenImportAllowlist.has(edge)) {
      errors.push(`peer screen dependency: ${edge}\n  move shared logic out of screens or add a narrowly justified allowlist entry`);
    }
  }
}

const state = new Map();
const stack = [];
const stackIndex = new Map();
const cycleKeys = new Set();

function recordCycle(target) {
  const start = stackIndex.get(target);
  const cycle = stack.slice(start).concat(target).map(repoPath);
  const body = cycle.slice(0, -1);
  const rotations = body.map((_, index) => body.slice(index).concat(body.slice(0, index)));
  rotations.sort((a, b) => a.join('\u0000').localeCompare(b.join('\u0000')));
  const canonical = rotations[0].concat(rotations[0][0]);
  const key = canonical.join(' -> ');
  if (!cycleKeys.has(key)) {
    cycleKeys.add(key);
    errors.push(`circular dependency:\n  ${cycle.join(' -> ')}`);
  }
}

function visit(fileName) {
  state.set(fileName, 1);
  stackIndex.set(fileName, stack.length);
  stack.push(fileName);

  const targets = [...graph.get(fileName)].sort((a, b) => repoPath(a).localeCompare(repoPath(b)));
  for (const target of targets) {
    const targetState = state.get(target) ?? 0;
    if (targetState === 0) visit(target);
    else if (targetState === 1) recordCycle(target);
  }

  stack.pop();
  stackIndex.delete(fileName);
  state.set(fileName, 2);
}

for (const fileName of [...graph.keys()].sort((a, b) => repoPath(a).localeCompare(repoPath(b)))) {
  if (!state.has(fileName)) visit(fileName);
}

if (errors.length) {
  console.error(`[architecture] FAILED with ${errors.length} violation${errors.length === 1 ? '' : 's'}:`);
  for (const error of errors) console.error(`\n- ${error}`);
  process.exit(1);
}

const edgeCount = [...graph.values()].reduce((count, targets) => count + targets.size, 0);
console.log(`[architecture] OK: ${graph.size} production TypeScript files, ${edgeCount} internal edges, no forbidden dependencies or cycles.`);
