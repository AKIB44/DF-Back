// ── God view presence recorder ───────────────────────────────────────────────
//
// Called fire-and-forget from the authenticate middleware on every verified
// request. Captures IP, device (parsed user-agent) and geo-IP location fully
// server-side — nothing is asked of or reported by the client.
//
// Writes are throttled per (user, ip, ua): at