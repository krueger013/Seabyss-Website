function canonicalReservationIdFrom(payload) {
    const candidates = [
        payload?.custom_parameters?.seabyss_reservation_id,
        payload?.order?.custom_parameters?.seabyss_reservation_id,
        payload?.transaction?.custom_parameters?.seabyss_reservation_id,
        payload?.billing?.transaction?.custom_parameters?.seabyss_reservation_id
    ].filter((value) => value !== undefined && value !== null);
    if (candidates.length === 0) {
        return null;
    }
    if (candidates.length !== 1 || typeof candidates[0] !== "string" ||
        candidates[0].length === 0 || candidates[0].length > 160 ||
        candidates[0] !== candidates[0].trim() || /\s/.test(candidates[0])) {
        throw new TypeError("Xsolla Starter reservation identity is invalid.");
    }
    return candidates[0];
}

export function createXsollaStarterPaidCoordinator({
    reservationStore,
    persistReconciliationCase,
    requireReservation = true
} = {}) {
    if (!reservationStore || typeof reservationStore.settlePaid !== "function" ||
        typeof persistReconciliationCase !== "function" ||
        typeof requireReservation !== "boolean") {
        throw new TypeError("Xsolla Starter paid coordinator is not configured.");
    }

    return Object.freeze({
        async settlePaid({
            payload,
            playFabId,
            transactionId,
            product,
            source,
            economicContract
        } = {}) {
            const reservationId = canonicalReservationIdFrom(payload);
            const settlement = await reservationStore.settlePaid({
                playFabId,
                xsollaSku: product?.xsollaSku,
                reservationId,
                transactionId,
                requireReservation
            });
            if (settlement?.status === "accepted" ||
                settlement?.status === "accepted_unreserved" ||
                settlement?.status === "replayed") {
                return Object.freeze({
                    status: settlement.status,
                    reservationId
                });
            }
            if (![
                "duplicate_paid",
                "pending_conflict",
                "reservation_missing"
            ].includes(settlement?.status)) {
                throw new Error("Starter paid settlement returned an invalid result.");
            }

            const persistedCase = await persistReconciliationCase({
                playFabId,
                transactionId,
                orderId: economicContract.orderId,
                productId: product.productId,
                xsollaSku: product.xsollaSku,
                source,
                reason: settlement.status,
                reservationId,
                productPlanVersion: economicContract.productPlanVersion,
                currency: economicContract.currency,
                unitAmountMinor: economicContract.unitAmountMinor,
                quantity: economicContract.quantity,
                totalAmountMinor: economicContract.totalAmountMinor,
                promotionPolicy: economicContract.promotionPolicy
            });
            return Object.freeze({
                status: "manual_reconciliation",
                reason: settlement.status,
                reservationId,
                caseKey: persistedCase?.key || null
            });
        }
    });
}
