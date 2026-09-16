// Kept inside the package so pnpm resolves its declared dependencies. No accounts or network calls.
const assert = require('node:assert/strict');
const { NTgCalls } = require('ntgcalls');
const { Api } = require('teleproto');
for (const name of ['RequestCall', 'AcceptCall', 'ConfirmCall', 'DiscardCall', 'SendSignalingData']) {
  assert.equal(typeof Api.phone[name], 'function', name);
}
assert.equal(typeof Api.UpdatePhoneCallSignalingData, 'function');
for (const name of ['createP2pCall', 'initExchange', 'exchangeKeys', 'connectP2p', 'onFrames', 'sendExternalFrame', 'onSignalingData', 'sendSignalingData']) {
  assert.equal(typeof NTgCalls.prototype[name], 'function', name);
}
const native = new NTgCalls();
native.calls().then(calls => {
  assert.equal(calls.size, 0);
  console.log(`Native smoke passed: ${process.version} ${process.platform}/${process.arch}`);
}).catch(() => { process.exitCode = 1; console.error('Native smoke failed'); });
