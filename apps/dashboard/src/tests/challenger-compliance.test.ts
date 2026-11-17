/**
 * AI Bridge Enterprise Dashboard — Compliance Audit Harness
 * Executed by teamwork_challenger
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SRC_DIR = path.resolve(__dirname, '..');

const ALLOWED_PACKAGES = new Set([
  'react',
  'react-dom',
  'react-dom/client',
  '@jacxishippingorg/jx-ui-react',
  'lucide-react',
  'motion',
  'motion/react',
]);

const FORBIDDEN_TOKENS = [
  'style=',
  'style =',
  'from-purple-',
  'from-pink-',
  'to-purple-',
  'to-pink-',
  'bg-gradient-',
  'blur-3xl',
  'blur-2xl',
  'animate-blob',
];

const EMOJI_REGEX = /[\u{1F300}-\u{1F5FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1F1E0}-\u{1F1FF}]/u;

function getAllSourceFiles(dir: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'tests' && entry.name !== 'legacy_reference' && entry.name !== 'node_modules') {
        results.push(...getAllSourceFiles(fullPath));
      }
    } else if (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts')) {
      results.push(fullPath);
    }
  }

  return results;
}

export interface ChallengerTestRecord {
  suite: string;
  name: string;
  passed: boolean;
  durationMs: number;
  error?: string;
}

export function runChallengerComplianceAudit(): { total: number; passed: number; failed: number; records: ChallengerTestRecord[] } {
  const start = performance.now();
  const result = auditSourceFiles();
  const durationMs = Number((performance.now() - start).toFixed(2));
  const records: ChallengerTestRecord[] = [
    {
      suite: 'Challenger Compliance Audit',
      name: 'Compliance audit: zero violations across production source files',
      passed: result.violations.length === 0,
      durationMs,
      error: result.violations.length > 0
        ? `${result.violations.length} compliance violations:\n${result.violations.map((v) => `  - [${v.rule}] ${v.file}: ${v.detail}`).join('\n')}`
        : undefined,
    },
  ];
  return { total: 1, passed: records[0].passed ? 1 : 0, failed: records[0].passed ? 0 : 1, records };
}

function auditSourceFiles(): { violations: Array<{ file: string; rule: string; detail: string }> } {
  console.log('>>> RUNNING CHALLENGER COMPLIANCE AUDIT <<<');
  const files = getAllSourceFiles(SRC_DIR);
  console.log(`Found ${files.length} production source files under src/`);

  const violations: Array<{ file: string; rule: string; detail: string }> = [];

  for (const file of files) {
    const relPath = path.relative(SRC_DIR, file);
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split('\n');

    // 1. Check for illegal imports
    const importRegex = /import\s+(?:(?:[\w*\s{},]+)\s+from\s+)?['"]([^'"]+)['"]/g;
    let match;
    while ((match = importRegex.exec(content)) !== null) {
      const pkg = match[1];
      if (pkg.startsWith('.') || pkg.startsWith('/')) {
        continue; // Relative import
      }
      if (!ALLOWED_PACKAGES.has(pkg)) {
        violations.push({
          file: relPath,
          rule: 'R1: Illegal external import',
          detail: `Imported '${pkg}' which is not in approved package list`,
        });
      }
    }

    // 2. Check for inline styles and forbidden tokens line-by-line
    lines.forEach((line, idx) => {
      for (const token of FORBIDDEN_TOKENS) {
        if (line.includes(token)) {
          violations.push({
            file: relPath,
            rule: `R1/R2: Forbidden token '${token}'`,
            detail: `Line ${idx + 1}: ${line.trim()}`,
          });
        }
      }

      // Check for emojis
      if (EMOJI_REGEX.test(line)) {
        violations.push({
          file: relPath,
          rule: 'R2/R3: Decorative emoji detected',
          detail: `Line ${idx + 1}: ${line.trim()}`,
        });
      }
    });
  }

  console.log('\n--- COMPLIANCE AUDIT RESULTS ---');
  if (violations.length === 0) {
    console.log('[PASS] ZERO compliance violations found across all production source files!');
    console.log('  ✓ No illegal external package imports');
    console.log('  ✓ Zero inline style={{...}} attributes');
    console.log('  ✓ Zero forbidden gradient or aesthetic tokens');
    console.log('  ✓ Zero decorative emojis');
  } else {
    console.error(`[FAIL] Found ${violations.length} compliance violations:`);
    violations.forEach((v) => console.error(`  - [${v.rule}] ${v.file}: ${v.detail}`));
  }

  return { violations };
}

// Auto-execute only when invoked directly via tsx (importing this file from the
// master runner must not run the audit or exit the process).
const isDirectExecution =
  process.argv[1]?.endsWith('challenger-compliance.test.ts') ||
  process.argv[1]?.endsWith('challenger-compliance.test.js');

if (isDirectExecution) {
  const { failed } = runChallengerComplianceAudit();
  process.exit(failed > 0 ? 1 : 0);
}
