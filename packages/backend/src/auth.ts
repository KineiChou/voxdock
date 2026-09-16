import { createHmac, timingSafeEqual } from "node:crypto";
export function signEvent(
  secret: string,
  timestamp: string,
  rawBody: string,
): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
}
export function verifyEvent(
  secret: string,
  timestamp: string,
  rawBody: string,
  signature: string,
  now: Date = new Date(),
): boolean {
  if (!/^\d{10,13}$/.test(timestamp) || !/^[a-f0-9]{64}$/.test(signature))
    return false;
  if (Math.abs(now.getTime() / 1000 - Number(timestamp)) > 300) return false;
  return timingSafeEqual(
    Buffer.from(signEvent(secret, timestamp, rawBody), "hex"),
    Buffer.from(signature, "hex"),
  );
}
export function tokenMatches(
  expected: string,
  actual: string | undefined,
): boolean {
  if (!actual) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}
