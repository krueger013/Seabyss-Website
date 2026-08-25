import { assertDiamondsLiveUnitySourceClean } from "./diamonds-live-source-scanner.js";

try {
    const result = await assertDiamondsLiveUnitySourceClean();
    process.stdout.write(`${JSON.stringify({
        kind: result.kind,
        domain: result.domain,
        filesScanned: result.filesScanned,
        counts: result.counts,
        forbiddenRouteCount: result.forbiddenRouteCount,
        readyForCanary: result.readyForCanary,
        scannerDigest: result.scannerDigest
    })}\n`);
} catch (error) {
    const scan = error?.scan;
    process.stderr.write(`${JSON.stringify({
        code: error?.code || "DIAMONDS_SCANNER_FAILED",
        message: error?.message || "Diamonds scanner failed.",
        forbiddenRouteCount: scan?.forbiddenRouteCount ?? null,
        scannerDigest: scan?.scannerDigest ?? null,
        forbiddenRoutes: scan?.routes
            ?.filter((route) => route.classification === "forbidden_direct_access")
            .map((route) => route.route) || [],
        forbiddenFindings: scan?.findings
            ?.filter((finding) => finding.classification === "forbidden_direct_access")
            .map(({ file, line, symbol, signal, route }) => ({ file, line, symbol, signal, route })) || []
    })}\n`);
    process.exitCode = 1;
}
