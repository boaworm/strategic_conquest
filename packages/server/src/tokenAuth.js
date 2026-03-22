import crypto from 'node:crypto';
/**
 * Generate a random 4-digit PIN.
 */
function pin4() {
    return String(crypto.randomInt(0, 10000)).padStart(4, '0');
}
/**
 * Generate three short PIN tokens for a game.
 */
export function generateTokens() {
    return {
        adminToken: pin4(),
        p1Token: pin4(),
        p2Token: pin4(),
    };
}
//# sourceMappingURL=tokenAuth.js.map