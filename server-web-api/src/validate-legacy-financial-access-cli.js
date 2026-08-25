#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    auditLegacyFinancialAccess,
    createLegacyFinancialAccessBaseline,
    LEGACY_FINANCIAL_ACCESS_MODES,
    loadLegacyFinancialAccessBaseline,
    scanLegacyFinancialAccess
} from "./legacy-financial-access-validator.js";

const USAGE = `Usage:
  node src/validate-legacy-financial-access-cli.js --root <unity-root> --mode <Legacy|ShadowRead|Cutover> [--baseline <json>] [--ignore <relative-path> ...]
  node src/validate-legacy-financial-access-cli.js --root <unity-root> --emit-baseline [--ignore <relative-path> ...]

Policy:
  Legacy/ShadowRead require an explicit baseline and fail on every new fingerprint or occurrence.
  Cutover ignores the baseline and requires zero legacy financial access findings.
  --emit-baseline is read-only: it prints a transparent manifest to stdout and never writes a file.`;

function requireValue(argv, index, flag) {
    const value = argv[index + 1];
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
        throw new TypeError(`${flag} requires a value.`);
    }
    return value;
}

function assignOnce(options, key, value, flag) {
    if (options[key] !== undefined) throw new TypeError(`${flag} may only be supplied once.`);
    options[key] = value;
}

export function parseLegacyFinancialAccessCliArgs(argv) {
    if (!Array.isArray(argv)) throw new TypeError("CLI argv must be an array.");
    const options = { ignoredPaths: [], compact: false, emitBaseline: false, help: false };
    for (let index = 0; index < argv.length; index += 1) {
        const flag = argv[index];
        if (flag === "--help" || flag === "-h") {
            options.help = true;
        } else if (flag === "--root") {
            const value = requireValue(argv, index, flag);
            assignOnce(options, "root", value, flag);
            index += 1;
        } else if (flag === "--mode") {
            const value = requireValue(argv, index, flag);
            assignOnce(options, "mode", value, flag);
            index += 1;
        } else if (flag === "--baseline") {
            const value = requireValue(argv, index, flag);
            assignOnce(options, "baselinePath", value, flag);
            index += 1;
        } else if (flag === "--ignore") {
            options.ignoredPaths.push(requireValue(argv, index, flag));
            index += 1;
        } else if (flag === "--maximum-file-bytes") {
            const raw = requireValue(argv, index, flag);
            if (!/^[1-9][0-9]*$/u.test(raw)) throw new TypeError(`${flag} must be a positive integer.`);
            assignOnce(options, "maximumFileBytes", Number(raw), flag);
            index += 1;
        } else if (flag === "--emit-baseline") {
            if (options.emitBaseline) throw new TypeError("--emit-baseline may only be supplied once.");
            options.emitBaseline = true;
        } else if (flag === "--compact") {
            options.compact = true;
        } else {
            throw new TypeError(`Unknown argument: ${String(flag)}`);
        }
    }
    if (options.help) return Object.freeze(options);
    if (typeof options.root !== "string") throw new TypeError("--root is required.");
    if (options.emitBaseline) {
        if (options.mode !== undefined || options.baselinePath !== undefined) {
            throw new TypeError("--emit-baseline cannot be combined with --mode or --baseline.");
        }
    } else {
        if (!LEGACY_FINANCIAL_ACCESS_MODES.includes(options.mode)) {
            throw new TypeError("--mode must be Legacy, ShadowRead or Cutover.");
        }
        if ((options.mode === "Legacy" || options.mode === "ShadowRead") &&
            typeof options.baselinePath !== "string") {
            throw new TypeError(`${options.mode} requires --baseline.`);
        }
    }
    return Object.freeze({ ...options, ignoredPaths: Object.freeze([...options.ignoredPaths]) });
}

function writeJson(stream, value, compact) {
    stream.write(`${JSON.stringify(value, null, compact ? 0 : 2)}\n`);
}

export async function runLegacyFinancialAccessCli(argv, {
    stdout = process.stdout,
    stderr = process.stderr
} = {}) {
    try {
        const options = parseLegacyFinancialAccessCliArgs(argv);
        if (options.help) {
            stdout.write(`${USAGE}\n`);
            return 0;
        }
        if (options.emitBaseline) {
            const scan = await scanLegacyFinancialAccess({
                root: options.root,
                additionalIgnoredPaths: options.ignoredPaths,
                ...(options.maximumFileBytes === undefined
                    ? {} : { maximumFileBytes: options.maximumFileBytes })
            });
            const baseline = createLegacyFinancialAccessBaseline({
                findings: scan.findings,
                sourceRootLabel: "Seabyss II Unity current legacy financial access",
                additionalIgnoredPaths: options.ignoredPaths
            });
            writeJson(stdout, {
                ...baseline,
                generationEvidence: {
                    scannedFileCount: scan.scannedFileCount,
                    findingCount: scan.findingCount,
                    categoryCounts: scan.categoryCounts,
                    ignoredCount: scan.ignoredCount
                }
            }, options.compact);
            return 0;
        }
        const baseline = options.baselinePath === undefined
            ? null
            : await loadLegacyFinancialAccessBaseline(options.baselinePath);
        const result = await auditLegacyFinancialAccess({
            root: options.root,
            mode: options.mode,
            baseline,
            additionalIgnoredPaths: options.ignoredPaths,
            ...(options.maximumFileBytes === undefined
                ? {} : { maximumFileBytes: options.maximumFileBytes })
        });
        writeJson(stdout, result, options.compact);
        return result.ready ? 0 : 1;
    } catch (error) {
        writeJson(stderr, {
            ready: false,
            status: "validator_configuration_error",
            error: {
                name: error instanceof TypeError ? "TypeError" : "Error",
                message: typeof error?.message === "string" ? error.message : "Validation failed."
            }
        }, false);
        return 2;
    }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
    const exitCode = await runLegacyFinancialAccessCli(process.argv.slice(2));
    process.exitCode = exitCode;
}
