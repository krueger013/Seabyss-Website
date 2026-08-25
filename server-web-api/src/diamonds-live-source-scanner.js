import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, relative, resolve, sep } from "node:path";

export const DIAMONDS_LIVE_SCANNER_KIND = "seabyss_diamonds_live_source_scan_v1";
export const DIAMONDS_LIVE_SCANNER_CLASSIFICATIONS = Object.freeze([
    "intentional_legacy_adapter",
    "migration_only",
    "forbidden_direct_access"
]);

const DEFAULT_UNITY_ROOT = fileURLToPath(new URL("../../../Sabyss II/", import.meta.url));
const DEFAULT_SOURCE_SUBDIRECTORY = join("Assets", "_Seabyss", "Scripts");
const CLASSIFICATION_SET = new Set(DIAMONDS_LIVE_SCANNER_CLASSIFICATIONS);
const SKIPPED_DIRECTORY_NAMES = new Set(["Editor", "Tests", "Test", "obj", "bin", "Library"]);

// These files are themselves narrowly-scoped adapters/projections. New direct
// access in every other source file requires a reviewed FINANCIAL_ACCESS marker.
const FILE_POLICIES = Object.freeze([
    Object.freeze({
        suffix: "Assets/_Seabyss/Scripts/Persistence/DiamondFinancialDomainRuntime.cs",
        classification: "intentional_legacy_adapter",
        route: "authoritative_diamond_service_runtime_adapter"
    }),
    Object.freeze({
        suffix: "Assets/_Seabyss/Scripts/Persistence/FinancialAuthorityCurrencyStore.cs",
        classification: "intentional_legacy_adapter",
        route: "financial_currency_store_adapter"
    }),
    Object.freeze({
        suffix: "Assets/_Seabyss/Scripts/Persistence/PlayFab/PlayFabVirtualCurrencyStore.cs",
        classification: "intentional_legacy_adapter",
        route: "playfab_dm_legacy_adapter"
    }),
    Object.freeze({
        suffix: "Assets/_Seabyss/Scripts/Persistence/PlayFab/PlayFabPlayerProfileStore.XsollaDiamond.cs",
        classification: "migration_only",
        route: "xsd1_legacy_drain"
    }),
    Object.freeze({
        suffix: "Assets/_Seabyss/Scripts/Persistence/FinanciallyIsolatedPlayerProfileStore.cs",
        classification: "migration_only",
        route: "profile_v1_financial_projection_fence"
    }),
    Object.freeze({
        suffix: "Assets/_Seabyss/Scripts/Persistence/FinancialAuthorityRuntime.cs",
        classification: "migration_only",
        route: "legacy_financial_projection"
    }),
    Object.freeze({
        suffix: "Assets/_Seabyss/Scripts/Persistence/FinancialProfileMergePolicy.cs",
        classification: "migration_only",
        route: "legacy_profile_merge"
    }),
    Object.freeze({
        suffix: "Assets/_Seabyss/Scripts/Persistence/StarterProfilePolicy.cs",
        classification: "migration_only",
        route: "legacy_profile_bootstrap"
    })
]);

const SIGNALS = Object.freeze([
    Object.freeze({
        kind: "playfab_add_virtual_currency",
        expression: /(?:\/Server\/AddUserVirtualCurrency|\bAddUserVirtualCurrency\s*\()/u
    }),
    Object.freeze({
        kind: "playfab_subtract_virtual_currency",
        expression: /(?:\/Server\/SubtractUserVirtualCurrency|\bSubtractUserVirtualCurrency\s*\()/u
    }),
    Object.freeze({
        kind: "legacy_diamond_store_add",
        expression: /\b(?:currencyStore|playFabCurrencyStore|virtualCurrencyStore|CurrencyStore|inner|store)\s*\??\.\s*AddDiamondsAsync\s*\(/u
    }),
    Object.freeze({
        kind: "legacy_diamond_store_subtract",
        expression: /\b(?:currencyStore|playFabCurrencyStore|virtualCurrencyStore|CurrencyStore|inner|store)\s*\??\.\s*SubtractDiamondsAsync\s*\(/u
    }),
    Object.freeze({
        kind: "profile_v1_diamond_write",
        expression: /\b[A-Za-z_][A-Za-z0-9_]*\.diamonds\s*(?:\+|-|\*|\/)?=/u
    })
]);

const ANNOTATION = /FINANCIAL_ACCESS:\s*(intentional_legacy_adapter|migration_only|forbidden_direct_access)\s+domain=Diamonds\s+route=([A-Za-z0-9_.:-]+)/u;
const METHOD_DECLARATION = /^\s*(?:(?:public|private|protected|internal|static|virtual|override|sealed|async|new|extern|partial)\s+)+(?:[A-Za-z_][A-Za-z0-9_<>,.?\[\]\s]*\s+)([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^>]+>)?\s*\(/u;
const CLASS_DECLARATION = /\b(?:class|struct|record)\s+([A-Za-z_][A-Za-z0-9_]*)/u;

function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function digest(value) {
    const serialized = typeof value === "string" ? value : JSON.stringify(stable(value));
    return createHash("sha256").update(serialized, "utf8").digest("hex");
}

function normalizePath(value) {
    return value.split(sep).join("/");
}

function coded(code, message, details = {}) {
    const error = new Error(message);
    error.code = code;
    Object.assign(error, details);
    return error;
}

async function listCsharpFiles(directory, result = []) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (!SKIPPED_DIRECTORY_NAMES.has(entry.name)) {
                await listCsharpFiles(join(directory, entry.name), result);
            }
        } else if (entry.isFile() && entry.name.endsWith(".cs") && !entry.name.endsWith("SelfTests.cs")) {
            result.push(join(directory, entry.name));
        }
    }
    return result;
}

function sourceSymbols(lines) {
    const symbols = [];
    let currentClass = null;
    let currentMethod = null;
    for (let index = 0; index < lines.length; index += 1) {
        const classMatch = CLASS_DECLARATION.exec(lines[index]);
        if (classMatch) currentClass = classMatch[1];
        const methodMatch = METHOD_DECLARATION.exec(lines[index]);
        if (methodMatch) currentMethod = methodMatch[1];
        symbols[index] = currentMethod || currentClass || "<file>";
    }
    return symbols;
}

function sourceAnnotations(lines, symbols) {
    const annotations = [];
    for (let index = 0; index < lines.length; index += 1) {
        const match = ANNOTATION.exec(lines[index]);
        if (!match) continue;
        let symbol = symbols[index];
        for (let lookAhead = index + 1; lookAhead < Math.min(lines.length, index + 9); lookAhead += 1) {
            const declaration = METHOD_DECLARATION.exec(lines[lookAhead]);
            if (declaration) {
                symbol = declaration[1];
                break;
            }
        }
        annotations.push(Object.freeze({
            line: index + 1,
            symbol,
            classification: match[1],
            route: match[2]
        }));
    }
    return annotations;
}

function filePolicy(relativeFile) {
    return FILE_POLICIES.find((entry) => relativeFile.endsWith(entry.suffix)) || null;
}

function classificationFor({ relativeFile, line, symbol, annotations }) {
    const exactScope = annotations
        .filter((entry) => entry.symbol === symbol && entry.line <= line)
        .sort((left, right) => right.line - left.line)[0];
    if (exactScope) return { ...exactScope, source: "source_annotation" };

    const nearby = annotations
        .filter((entry) => entry.line <= line && line - entry.line <= 4)
        .sort((left, right) => right.line - left.line)[0];
    if (nearby) return { ...nearby, source: "source_annotation" };

    const policy = filePolicy(relativeFile);
    if (policy) return { ...policy, source: "narrow_file_policy" };

    return {
        classification: "forbidden_direct_access",
        route: `${relativeFile}:${symbol}`,
        source: "fail_closed_default"
    };
}

function scanFile({ unityRoot, file, source }) {
    const relativeFile = normalizePath(relative(unityRoot, file));
    const lines = source.split(/\r?\n/u);
    const symbols = sourceSymbols(lines);
    const annotations = sourceAnnotations(lines, symbols);
    const findings = [];
    for (let index = 0; index < lines.length; index += 1) {
        for (const signal of SIGNALS) {
            if (!signal.expression.test(lines[index])) continue;
            const classification = classificationFor({
                relativeFile,
                line: index + 1,
                symbol: symbols[index],
                annotations
            });
            if (!CLASSIFICATION_SET.has(classification.classification)) {
                throw coded("DIAMONDS_SCANNER_POLICY_INVALID", "Unknown Diamonds classification.");
            }
            findings.push(Object.freeze({
                file: relativeFile,
                line: index + 1,
                symbol: symbols[index],
                signal: signal.kind,
                classification: classification.classification,
                classificationSource: classification.source,
                route: classification.route,
                sourceLineDigest: digest(lines[index].trim())
            }));
        }
    }
    return { findings, sourceDigest: digest(source), relativeFile };
}

export async function scanDiamondsLiveUnitySource({
    unityRoot = process.env.SEABYSS_UNITY_ROOT || DEFAULT_UNITY_ROOT,
    sourceSubdirectory = DEFAULT_SOURCE_SUBDIRECTORY
} = {}) {
    const root = resolve(unityRoot);
    const sourceRoot = resolve(root, sourceSubdirectory);
    const rootInfo = await stat(root).catch(() => null);
    const sourceInfo = await stat(sourceRoot).catch(() => null);
    if (!rootInfo?.isDirectory() || !sourceInfo?.isDirectory() ||
        !sourceRoot.startsWith(`${root}${sep}`)) {
        throw coded("DIAMONDS_SCANNER_SOURCE_UNAVAILABLE",
            "Unity production source root is unavailable or escapes the configured project.");
    }
    const files = (await listCsharpFiles(sourceRoot)).sort((left, right) => left.localeCompare(right));
    if (files.length === 0) {
        throw coded("DIAMONDS_SCANNER_SOURCE_EMPTY", "Unity production source scan found no C# files.");
    }
    const findings = [];
    const sourceFiles = [];
    for (const file of files) {
        const source = await readFile(file, "utf8");
        const scanned = scanFile({ unityRoot: root, file, source });
        findings.push(...scanned.findings);
        sourceFiles.push({ file: scanned.relativeFile, digest: scanned.sourceDigest });
    }
    const routes = [...new Map(findings.map((finding) => [
        `${finding.classification}:${finding.route}`,
        Object.freeze({
            route: finding.route,
            classification: finding.classification,
            files: [...new Set(findings
                .filter((entry) => entry.classification === finding.classification && entry.route === finding.route)
                .map((entry) => entry.file))].sort(),
            signalCount: findings.filter((entry) =>
                entry.classification === finding.classification && entry.route === finding.route).length
        })
    ])).values()].sort((left, right) => left.route.localeCompare(right.route));
    const counts = Object.fromEntries(DIAMONDS_LIVE_SCANNER_CLASSIFICATIONS.map((classification) => [
        classification,
        routes.filter((route) => route.classification === classification).length
    ]));
    const evidence = {
        kind: DIAMONDS_LIVE_SCANNER_KIND,
        schemaVersion: 1,
        domain: "Diamonds",
        filesScanned: files.length,
        sourceFiles,
        findings,
        routes,
        counts,
        forbiddenRouteCount: counts.forbidden_direct_access,
        readyForCanary: counts.forbidden_direct_access === 0
    };
    return Object.freeze({ ...evidence, scannerDigest: digest(evidence) });
}

export async function assertDiamondsLiveUnitySourceClean(options = {}) {
    const result = await scanDiamondsLiveUnitySource(options);
    if (!result.readyForCanary) {
        throw coded("DIAMONDS_FORBIDDEN_DIRECT_ACCESS",
            `Diamonds live source contains ${result.forbiddenRouteCount} forbidden direct route(s).`,
            { scan: result });
    }
    return result;
}

export function scanDiamondsSourceTextForTests({
    source,
    relativeFile = "Assets/_Seabyss/Scripts/TestSubject.cs"
} = {}) {
    if (typeof source !== "string") throw new TypeError("source is required.");
    return scanFile({ unityRoot: "C:/fixture", file: `C:/fixture/${relativeFile}`, source });
}
