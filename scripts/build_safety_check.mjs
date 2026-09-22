import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const roots = ['netlify/functions', 'netlify/edge-functions', 'src'];
const extensions = new Set(['.ts','.mts','.tsx','.js','.mjs','.jsx','.astro']);
const failures = [];

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes:true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return extensions.has(path.extname(entry.name)) ? [full] : [];
  });
}

function lineOf(sourceFile, pos) {
  return sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
}

function checkScript(file) {
  const text = fs.readFileSync(file, 'utf8');
  const kind = file.endsWith('.tsx') || file.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);

  for (const diagnostic of sourceFile.parseDiagnostics || []) {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
    failures.push(file + ':' + lineOf(sourceFile, diagnostic.start || 0) + ' syntax: ' + message);
  }

  let defaultExports = 0;
  let configExports = 0;
  const functionBodies = new Map();

  for (const statement of sourceFile.statements) {
    const modifiers = statement.modifiers || [];
    const isExport = modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    const isDefault = modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
    if (isExport && isDefault) defaultExports += 1;

    if (ts.isVariableStatement(statement) && isExport) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === 'config') configExports += 1;
      }
    }

    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
      const name = statement.name.text;
      const rows = functionBodies.get(name) || [];
      rows.push(lineOf(sourceFile, statement.pos));
      functionBodies.set(name, rows);
    }
  }

  if (defaultExports > 1) failures.push(file + ': multiple default exports (' + defaultExports + ')');
  if (configExports > 1) failures.push(file + ': multiple exported config declarations (' + configExports + ')');

  for (const [name, lines] of functionBodies) {
    if (lines.length > 1) failures.push(file + ': duplicate top-level function "' + name + '" at lines ' + lines.join(', '));
  }

  const suspicious = [
    /export\s+const\s+config[^\n;]*;\s*\+/,
    /export\s+default[\s\S]{0,80}export\s+default/,
  ];
  for (const pattern of suspicious) {
    if (pattern.test(text)) failures.push(file + ': suspicious concatenated/duplicated export structure');
  }
}

for (const file of roots.flatMap(walk)) {
  if (file.endsWith('.astro')) {
    const text = fs.readFileSync(file, 'utf8');
    if ((text.match(/<script\b/g) || []).length > 6) {
      failures.push(file + ': unusually high number of script blocks; inspect for accidental duplication');
    }
    if (/\$\$\$\s*\(/.test(text)) {
      failures.push(file + ': invalid triple-dollar selector helper ($$) detected');
    }
    if (/(^|[^$])\$\([^\n]*?\)\.forEach\s*\(/m.test(text)) {
      failures.push(file + ': single-element $() selector cannot be iterated with forEach; use $()');
    }
    continue;
  }
  checkScript(file);
}

if (failures.length) {
  console.error('\nBuild-safety audit failed:\n');
  for (const failure of failures) console.error(' - ' + failure);
  console.error('\nFix these structural errors before building or deploying.\n');
  process.exit(2);
}

console.log('Build-safety audit passed: no malformed syntax, duplicate default/config exports, or duplicate top-level function bodies detected.');
