import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

export const LEGACY_FINANCIAL_ACCESS_BASELINE_SCHEMA_VERSION = 1;
export const LEGACY_FINANCIAL_ACCESS_MODES = Object.freeze([
    "Legacy",
    "ShadowRead",
    "Cutover"
]);

export const LEGACY_FINANCIAL_ACCESS_CATEGORIES = Object.freeze([
    "legacy_playfab_currency",
    "legacy_profile_write",
    "direct_inventory_mutation"
]);

export const DEFAULT_IGNORED_CANONICAL_FILES = Object.freeze([
    "FinancialAuthorityCurrencyStore.cs",
    "FinancialAuthorityCutoverGate.cs",
    "FinancialAuthorityRuntime.cs",
    "FinancialAuthorityStateV2.cs",
    "FinancialProfileMergePolicy.cs",
    "FinancialProfileSnapshotV2.cs",
    "FinancialResourceRegistry.cs",
    "FinanciallyIsolatedPlayerProfileStore.cs",
    "PlayFabFinancialAuthorityV2RestTransport.cs",
    "PlayFabFinancialAuthorityV2Store.cs",
    "PlayerProfileStoreMode.cs"
]);

const DEFAULT_IGNORED_DIRECTORIES = new Set([
    ".git", ".idea", ".vs", ".vscode", "Library", "Logs", "obj", "Obj",
    "Temp", "UserSettings"
]);
const DEFAULT_IGNORED_SOURCE_PREFIXES = Object.freeze([
    "Assets/PlayFabSDK",
    "Assets/Mirror"
]);
const DEFAULT_IGNORED_CANONICAL_SET = new Set(DEFAULT_IGNORED_CANONICAL_FILES);
const FINANCIAL_FIELD_NAMES = Object.freeze([
    "gold", "diamonds", "sirenTears", "elitePoints", "ammo", "usableItems",
    "cannons", "harpoons", "ownedDestinationMarkerIds", "ownedShipDesignIds",
    "shopEntitlements", "durableEconomyTransactions"
]);
const FINANCIAL_FIELD_PATTERN = FINANCIAL_FIELD_NAMES.join("|");
const QUALIFIED_PROFILE_FIELD_MUTATION = new RegExp(
    `\\b[A-Za-z_][A-Za-z0-9_]*\\s*\\.\\s*(?:${FINANCIAL_FIELD_PATTERN})\\b\\s*` +
    "(?:\\+\\+|--|\\+=|-=|\\*=|\\/=|=(?!=|>)|\\.\\s*(?:Add|Remove|RemoveAt|RemoveAll|Clear)\\s*\\()",
    "u"
);
const PLAYER_REWARD_STATE_DECLARATION = /\bclass\s+PlayerRewardState\b/u;
const PLAYER_REWARD_STATE_COMPOUND_MUTATION =
    /\b(?:gold|diamonds|sirenTears|elitePoints)\b\s*(?:\+\+|--|\+=|-=|\*=|\/=)/u;
const FINANCIAL_STATE_NOUN = [
    "Gold", "Diamonds?", "VirtualCurrenc(?:y|ies)", "MarketCurrenc(?:y|ies)",
    "Currencies?", "Balances?", "SirenTears?", "ElitePoints?", "Ammo", "Cannonballs?",
    "Balls?", "Amulets?", "Powders?", "Plates?", "StarDust", "Stardust", "ThorsWrath",
    "Cannons?", "Harpoons?", "DestinationMarkers?", "Markers?", "ShipDesigns?", "Designs?",
    "Premium", "Entitlements?", "Consumables?", "InventoryItems?", "UsableItems?"
].join("|");
const STATE_MUTATION_CALL = new RegExp(
    `\\.\\s*(?:Server)?(?:Add|Grant|Remove|Consume|TryConsume|Spend|TrySpend|Set|Apply|Unlock)` +
    `(?:${FINANCIAL_STATE_NOUN})(?:Async)?\\s*\\(`,
    "iu"
);
const INVENTORY_QUANTITY_MUTATION =
    /\.\s*(?:amount|owned|quantity|stackCount)\b\s*(?:\+\+|--|\+=|-=|\*=|\/=|=(?!=|>))/u;
const INVENTORY_CONTEXT = /\b(?:ammo|usableItems?|inventory|consumables?|cannons?|harpoons?|amulets?|powders?|plates?|stardust|starDust|thorsWrath)\b/iu;
const LEGACY_CURRENCY_API =
    /(?:\.\s*(?:AddUserVirtualCurrency|SubtractUserVirtualCurrency)\s*\(|["'][^"'\r\n]*\/Server\/(?:AddUserVirtualCurrency|SubtractUserVirtualCurrency)["'])/u;
const LEGACY_CURRENCY_CODE = /["'](?:DM|GD)["']/u;
const LEGACY_CURRENCY_CONTEXT =
    /(?:\b(?:PlayFab|VirtualCurrenc(?:y|ies)|GetUserInventory|AddUserVirtualCurrency|SubtractUserVirtualCurrency)\b|\b[A-Za-z_][A-Za-z0-9_]*CurrencyCode\b)/u;
const PROFILE_STORAGE_WRITE = /\b(?:UpdateUserInternalDataRequest|UpdateUserDataRequest|UpdateUserInternalData|UpdateUserData|SetObjectsRequest)\b/u;
const PROFILE_V1_LITERAL = /["']profile_v1["']/u;
const PROVIDER_INVENTORY_MUTATION =
    /\.\s*(?:AddInventoryItems|SubtractInventoryItems|UpdateInventoryItems|DeleteInventoryItems|GrantItemsToUser|RevokeInventoryItem)\s*\(/u;

function plain(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalString(value, name, maximumLength = 4096) {
    if (typeof value !== "string" || value.length === 0 || value.length > maximumLength ||
        value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
        throw new TypeError(`${name} is invalid.`);
    }
    return value;
}

function positiveInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
        throw new TypeError(`${name} is invalid.`);
    }
    return value;
}

function nonNegativeInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
    if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
        throw new TypeError(`${name} is invalid.`);
    }
    return value;
}

function deepFreeze(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
    return value;
}

function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (!plain(value)) return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function sha256(value) {
    return createHash("sha256").update(JSON.stringify(stable(value)), "utf8").digest("hex");
}

function posixRelative(value) {
    return value.split(path.sep).join("/");
}

function normalizeSnippet(value) {
    return value.trim().replace(/\s+/gu, " ").slice(0, 800);
}

function findingFingerprint({ category, detector, relativePath, snippet }) {
    return sha256({ category, detector, path: relativePath, snippet });
}

function isTestPath(relativePath) {
    const segments = relativePath.split("/");
    const basename = segments.at(-1) || "";
    return segments.some((segment) => /^(?:Tests?|TestFixtures?)$/iu.test(segment)) ||
        /(?:^|[._-])Tests?\.cs$/iu.test(basename);
}

function isMigrationPath(relativePath) {
    return relativePath.split("/").some((segment) => /Migration/iu.test(segment));
}

function normalizeExplicitIgnoredPaths(values) {
    if (values === undefined) return [];
    if (!Array.isArray(values)) throw new TypeError("additionalIgnoredPaths must be an array.");
    return values.map((value, index) => {
        canonicalString(value, `additionalIgnoredPaths[${index}]`, 4096);
        const normalized = value.replace(/\\/gu, "/").replace(/^\.\//u, "").replace(/\/$/u, "");
        if (normalized.length === 0 || normalized === "." || normalized === ".." ||
            normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
            throw new TypeError(`additionalIgnoredPaths[${index}] is invalid.`);
        }
        return normalized;
    }).sort((left, right) => left.localeCompare(right));
}

function explicitlyIgnored(relativePath, ignoredPaths) {
    return ignoredPaths.some((entry) => relativePath === entry || relativePath.startsWith(`${entry}/`));
}

function ignoreReason(relativePath, ignoredPaths) {
    const segments = relativePath.split("/");
    const basename = segments.at(-1) || "";
    if (segments.some((segment) => DEFAULT_IGNORED_DIRECTORIES.has(segment))) return "generated_directory";
    if (segments.some((segment) => segment === "Editor")) return "editor_only";
    if (isTestPath(relativePath)) return "test";
    if (isMigrationPath(relativePath)) return "migration";
    if (DEFAULT_IGNORED_CANONICAL_SET.has(basename)) return "canonical_financial_file";
    if (DEFAULT_IGNORED_SOURCE_PREFIXES.some((prefix) =>
        relativePath === prefix || relativePath.startsWith(`${prefix}/`))) {
        return "third_party_source";
    }
    if (explicitlyIgnored(relativePath, ignoredPaths)) return "explicit_manifest_ignore";
    return null;
}

function stripCSharpComments(source) {
    let result = "";
    let inBlock = false;
    let inString = false;
    let inChar = false;
    let verbatim = false;
    let escaped = false;
    for (let index = 0; index < source.length; index += 1) {
        const current = source[index];
        const next = source[index + 1] || "";
        if (inBlock) {
            if (current === "*" && next === "/") {
                result += "  ";
                index += 1;
                inBlock = false;
            } else {
                result += current === "\n" || current === "\r" ? current : " ";
            }
            continue;
        }
        if (!inString && !inChar && current === "/" && next === "*") {
            result += "  ";
            index += 1;
            inBlock = true;
            continue;
        }
        if (!inString && !inChar && current === "/" && next === "/") {
            while (index < source.length && source[index] !== "\n" && source[index] !== "\r") {
                result += " ";
                index += 1;
            }
            index -= 1;
            continue;
        }
        result += current;
        if (inString) {
            if (verbatim && current === '"' && next === '"') {
                result += next;
                index += 1;
                continue;
            }
            if (!verbatim && current === "\\" && !escaped) {
                escaped = true;
                continue;
            }
            if (current === '"' && !escaped) {
                inString = false;
                verbatim = false;
            }
            escaped = false;
            continue;
        }
        if (inChar) {
            if (current === "\\" && !escaped) {
                escaped = true;
                continue;
            }
            if (current === "'" && !escaped) inChar = false;
            escaped = false;
            continue;
        }
        if (current === '"') {
            inString = true;
            verbatim = index > 0 && source[index - 1] === "@";
        } else if (current === "'") {
            inChar = true;
        }
    }
    return result;
}

function addFinding(findings, seen, relativePath, lineNumber, line, category, detector) {
    const snippet = normalizeSnippet(line);
    if (snippet.length === 0) return;
    const identity = `${lineNumber}\n${category}\n${detector}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    const fingerprint = findingFingerprint({ category, detector, relativePath, snippet });
    findings.push(Object.freeze({
        category,
        detector,
        path: relativePath,
        line: lineNumber,
        snippet,
        fingerprint
    }));
}

function inspectCSharp(relativePath, source) {
    const sanitizedSource = stripCSharpComments(source);
    const sanitizedLines = sanitizedSource.split(/\r?\n/u);
    const playerRewardState = PLAYER_REWARD_STATE_DECLARATION.test(sanitizedSource);
    const profileV1Write = PROFILE_V1_LITERAL.test(sanitizedSource) && PROFILE_STORAGE_WRITE.test(sanitizedSource);
    const findings = [];
    const seen = new Set();
    for (let index = 0; index < sanitizedLines.length; index += 1) {
        const line = sanitizedLines[index];
        if (line.trim().length === 0) continue;
        const near = sanitizedLines.slice(Math.max(0, index - 3), index + 4).join(" ");
        const lineNumber = index + 1;

        if (LEGACY_CURRENCY_API.test(line)) {
            addFinding(findings, seen, relativePath, lineNumber, line,
                "legacy_playfab_currency", "legacy_virtual_currency_mutation_api");
        }
        if (LEGACY_CURRENCY_CODE.test(line) && LEGACY_CURRENCY_CONTEXT.test(near)) {
            addFinding(findings, seen, relativePath, lineNumber, line,
                "legacy_playfab_currency", "legacy_DM_GD_currency_code");
        }
        if (profileV1Write && PROFILE_STORAGE_WRITE.test(line)) {
            addFinding(findings, seen, relativePath, lineNumber, line,
                "legacy_profile_write", "legacy_profile_storage_write_api");
        }
        if (profileV1Write && PROFILE_V1_LITERAL.test(line)) {
            addFinding(findings, seen, relativePath, lineNumber, line,
                "legacy_profile_write", "profile_v1_storage_write");
        }
        if (QUALIFIED_PROFILE_FIELD_MUTATION.test(line)) {
            addFinding(findings, seen, relativePath, lineNumber, line,
                "legacy_profile_write", "financial_profile_field_mutation");
        }
        if (playerRewardState && PLAYER_REWARD_STATE_COMPOUND_MUTATION.test(line)) {
            addFinding(findings, seen, relativePath, lineNumber, line,
                "legacy_profile_write", "player_reward_state_compound_mutation");
        }
        if (PROVIDER_INVENTORY_MUTATION.test(line)) {
            addFinding(findings, seen, relativePath, lineNumber, line,
                "direct_inventory_mutation", "provider_inventory_mutation_api");
        }
        if (STATE_MUTATION_CALL.test(line)) {
            addFinding(findings, seen, relativePath, lineNumber, line,
                "direct_inventory_mutation", "gameplay_financial_mutation_call");
        }
        if (INVENTORY_QUANTITY_MUTATION.test(line) && INVENTORY_CONTEXT.test(near)) {
            addFinding(findings, seen, relativePath, lineNumber, line,
                "direct_inventory_mutation", "inventory_quantity_mutation");
        }
    }
    return findings;
}

function aggregateFindings(findings) {
    const aggregates = new Map();
    for (const finding of findings) {
        if (!plain(finding)) throw new TypeError("Financial access finding is invalid.");
        const category = canonicalString(finding.category, "finding.category", 128);
        if (!LEGACY_FINANCIAL_ACCESS_CATEGORIES.includes(category)) {
            throw new TypeError("Financial access finding category is invalid.");
        }
        const detector = canonicalString(finding.detector, "finding.detector", 160);
        const relativePath = canonicalString(finding.path, "finding.path", 4096)
            .replace(/\\/gu, "/");
        const snippet = canonicalString(finding.snippet, "finding.snippet", 800);
        const expected = findingFingerprint({ category, detector, relativePath, snippet });
        if (finding.fingerprint !== expected) throw new TypeError("Financial access finding fingerprint is invalid.");
        const line = positiveInteger(finding.line, "finding.line", 100_000_000);
        const current = aggregates.get(expected) || {
            fingerprint: expected,
            category,
            detector,
            path: relativePath,
            snippet,
            count: 0,
            lines: []
        };
        current.count += 1;
        current.lines.push(line);
        aggregates.set(expected, current);
    }
    return [...aggregates.values()]
        .map((entry) => ({ ...entry, lines: [...entry.lines].sort((left, right) => left - right) }))
        .sort((left, right) => left.path.localeCompare(right.path) ||
            left.category.localeCompare(right.category) || left.detector.localeCompare(right.detector) ||
            left.fingerprint.localeCompare(right.fingerprint));
}

function validateBaseline(value) {
    if (!plain(value) || value.schemaVersion !== LEGACY_FINANCIAL_ACCESS_BASELINE_SCHEMA_VERSION ||
        value.kind !== "seabyss_unity_legacy_financial_access_baseline" || !Array.isArray(value.entries)) {
        throw new TypeError("Legacy financial access baseline is invalid.");
    }
    const seen = new Set();
    const entries = value.entries.map((raw, index) => {
        if (!plain(raw)) throw new TypeError(`baseline.entries[${index}] is invalid.`);
        const category = canonicalString(raw.category, `baseline.entries[${index}].category`, 128);
        if (!LEGACY_FINANCIAL_ACCESS_CATEGORIES.includes(category)) {
            throw new TypeError(`baseline.entries[${index}].category is invalid.`);
        }
        const detector = canonicalString(raw.detector, `baseline.entries[${index}].detector`, 160);
        const relativePath = canonicalString(raw.path, `baseline.entries[${index}].path`, 4096)
            .replace(/\\/gu, "/");
        const snippet = canonicalString(raw.snippet, `baseline.entries[${index}].snippet`, 800);
        const count = positiveInteger(raw.count, `baseline.entries[${index}].count`, 1_000_000);
        const fingerprint = findingFingerprint({ category, detector, relativePath, snippet });
        if (raw.fingerprint !== fingerprint || seen.has(fingerprint)) {
            throw new TypeError(`baseline.entries[${index}].fingerprint is invalid or duplicated.`);
        }
        seen.add(fingerprint);
        return { fingerprint, category, detector, path: relativePath, snippet, count };
    }).sort((left, right) => left.path.localeCompare(right.path) ||
        left.category.localeCompare(right.category) || left.detector.localeCompare(right.detector) ||
        left.fingerprint.localeCompare(right.fingerprint));
    return deepFreeze({
        schemaVersion: LEGACY_FINANCIAL_ACCESS_BASELINE_SCHEMA_VERSION,
        kind: value.kind,
        sourceRootLabel: typeof value.sourceRootLabel === "string" ? value.sourceRootLabel : "Unity",
        ignoredCanonicalFiles: Array.isArray(value.ignoredCanonicalFiles)
            ? [...value.ignoredCanonicalFiles]
            : [...DEFAULT_IGNORED_CANONICAL_FILES],
        entries
    });
}

export async function scanLegacyFinancialAccess({
    root,
    additionalIgnoredPaths = [],
    maximumFileBytes = 2 * 1024 * 1024
} = {}) {
    canonicalString(root, "root", 32_768);
    positiveInteger(maximumFileBytes, "maximumFileBytes", 64 * 1024 * 1024);
    const ignoredPaths = normalizeExplicitIgnoredPaths(additionalIgnoredPaths);
    const absoluteRoot = path.resolve(root);
    const rootStat = await lstat(absoluteRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
        throw new TypeError("Unity scan root must be a real directory, not a symlink.");
    }
    const findings = [];
    const ignored = [];
    let scannedFileCount = 0;
    let oversizedFileCount = 0;
    let symlinkCount = 0;

    async function walk(absoluteDirectory) {
        const entries = await readdir(absoluteDirectory, { withFileTypes: true });
        entries.sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
            const absolute = path.join(absoluteDirectory, entry.name);
            const relative = posixRelative(path.relative(absoluteRoot, absolute));
            const reason = ignoreReason(relative, ignoredPaths);
            if (reason !== null) {
                ignored.push({ path: relative, reason });
                continue;
            }
            if (entry.isSymbolicLink()) {
                symlinkCount += 1;
                ignored.push({ path: relative, reason: "symlink" });
                continue;
            }
            if (entry.isDirectory()) {
                await walk(absolute);
                continue;
            }
            if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".cs") continue;
            const fileStat = await lstat(absolute);
            if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
                symlinkCount += 1;
                ignored.push({ path: relative, reason: "symlink" });
                continue;
            }
            if (fileStat.size > maximumFileBytes) {
                oversizedFileCount += 1;
                ignored.push({ path: relative, reason: "oversized" });
                continue;
            }
            const source = await readFile(absolute, "utf8");
            if (source.includes("\u0000")) {
                ignored.push({ path: relative, reason: "binary" });
                continue;
            }
            scannedFileCount += 1;
            findings.push(...inspectCSharp(relative, source));
        }
    }

    await walk(absoluteRoot);
    findings.sort((left, right) => left.path.localeCompare(right.path) ||
        left.line - right.line || left.category.localeCompare(right.category) ||
        left.detector.localeCompare(right.detector));
    ignored.sort((left, right) => left.path.localeCompare(right.path) || left.reason.localeCompare(right.reason));
    const categoryCounts = Object.fromEntries(LEGACY_FINANCIAL_ACCESS_CATEGORIES.map((category) => [
        category,
        findings.filter((finding) => finding.category === category).length
    ]));
    return deepFreeze({
        schemaVersion: 1,
        root: absoluteRoot,
        scannedFileCount,
        findingCount: findings.length,
        categoryCounts,
        ignoredCount: ignored.length,
        oversizedFileCount,
        symlinkCount,
        ignored,
        findings
    });
}

export function createLegacyFinancialAccessBaseline({
    findings,
    sourceRootLabel = "Seabyss II Unity",
    additionalIgnoredPaths = []
} = {}) {
    canonicalString(sourceRootLabel, "sourceRootLabel", 512);
    const ignoredPaths = normalizeExplicitIgnoredPaths(additionalIgnoredPaths);
    const entries = aggregateFindings(findings).map(({ lines: _lines, ...entry }) => entry);
    return deepFreeze({
        schemaVersion: LEGACY_FINANCIAL_ACCESS_BASELINE_SCHEMA_VERSION,
        kind: "seabyss_unity_legacy_financial_access_baseline",
        sourceRootLabel,
        policy: {
            Legacy: "existing fingerprints allowed; every new occurrence fails",
            ShadowRead: "existing fingerprints allowed; every new occurrence fails",
            Cutover: "baseline ignored; every finding fails"
        },
        ignoredCanonicalFiles: [...DEFAULT_IGNORED_CANONICAL_FILES],
        additionalIgnoredPaths: ignoredPaths,
        entries,
        digest: sha256(entries)
    });
}

export function validateLegacyFinancialAccess({ mode, findings, baseline = null } = {}) {
    if (!LEGACY_FINANCIAL_ACCESS_MODES.includes(mode)) {
        throw new TypeError("Legacy financial access mode must be Legacy, ShadowRead or Cutover.");
    }
    if (!Array.isArray(findings)) throw new TypeError("Legacy financial access findings are required.");
    const current = aggregateFindings(findings);
    if (mode === "Cutover") {
        const findingCount = current.reduce((sum, entry) => sum + entry.count, 0);
        return deepFreeze({
            mode,
            ready: findingCount === 0,
            status: findingCount === 0 ? "cutover_clean" : "cutover_legacy_access_present",
            counts: {
                findings: findingCount,
                baselineOccurrences: 0,
                unchangedOccurrences: 0,
                newOccurrences: findingCount,
                resolvedOccurrences: 0
            },
            newHits: current.map((entry) => ({ ...entry, allowedCount: 0, newCount: entry.count })),
            resolvedHits: []
        });
    }
    if (baseline === null || baseline === undefined) {
        throw new TypeError(`${mode} requires an explicit legacy financial access baseline.`);
    }
    const normalizedBaseline = validateBaseline(baseline);
    const allowed = new Map(normalizedBaseline.entries.map((entry) => [entry.fingerprint, entry]));
    const observed = new Map(current.map((entry) => [entry.fingerprint, entry]));
    const newHits = [];
    const resolvedHits = [];
    let unchangedOccurrences = 0;
    let newOccurrences = 0;
    let resolvedOccurrences = 0;
    for (const entry of current) {
        const baselineEntry = allowed.get(entry.fingerprint);
        const allowedCount = baselineEntry?.count ?? 0;
        unchangedOccurrences += Math.min(entry.count, allowedCount);
        if (entry.count > allowedCount) {
            const newCount = entry.count - allowedCount;
            newOccurrences += newCount;
            newHits.push({ ...entry, allowedCount, newCount });
        }
    }
    for (const entry of normalizedBaseline.entries) {
        const currentCount = observed.get(entry.fingerprint)?.count ?? 0;
        if (currentCount < entry.count) {
            const resolvedCount = entry.count - currentCount;
            resolvedOccurrences += resolvedCount;
            resolvedHits.push({ ...entry, currentCount, resolvedCount });
        }
    }
    const findingCount = current.reduce((sum, entry) => sum + entry.count, 0);
    const baselineOccurrences = normalizedBaseline.entries.reduce((sum, entry) => sum + entry.count, 0);
    return deepFreeze({
        mode,
        ready: newOccurrences === 0,
        status: newOccurrences === 0 ? "baseline_match" : "new_legacy_access_detected",
        baselineDigest: sha256(normalizedBaseline.entries),
        counts: {
            findings: findingCount,
            baselineOccurrences,
            unchangedOccurrences,
            newOccurrences,
            resolvedOccurrences
        },
        newHits,
        resolvedHits
    });
}

export async function auditLegacyFinancialAccess({
    root,
    mode,
    baseline = null,
    additionalIgnoredPaths = [],
    maximumFileBytes
} = {}) {
    const scan = await scanLegacyFinancialAccess({
        root,
        additionalIgnoredPaths,
        ...(maximumFileBytes === undefined ? {} : { maximumFileBytes })
    });
    const validation = validateLegacyFinancialAccess({ mode, findings: scan.findings, baseline });
    return deepFreeze({
        schemaVersion: 1,
        mode,
        ready: validation.ready,
        status: validation.status,
        root: scan.root,
        scan: {
            scannedFileCount: scan.scannedFileCount,
            findingCount: scan.findingCount,
            categoryCounts: scan.categoryCounts,
            ignoredCount: scan.ignoredCount,
            oversizedFileCount: scan.oversizedFileCount,
            symlinkCount: scan.symlinkCount
        },
        validation
    });
}

export async function loadLegacyFinancialAccessBaseline(filePath, {
    maximumBytes = 8 * 1024 * 1024
} = {}) {
    canonicalString(filePath, "baseline file path", 32_768);
    positiveInteger(maximumBytes, "maximumBytes", 64 * 1024 * 1024);
    const absolute = path.resolve(filePath);
    const stat = await lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximumBytes) {
        throw new TypeError("Legacy financial access baseline file is invalid.");
    }
    const raw = await readFile(absolute, "utf8");
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new TypeError("Legacy financial access baseline is invalid JSON.");
    }
    return validateBaseline(parsed);
}
