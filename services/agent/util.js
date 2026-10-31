/* SPDX-License-Identifier: MIT */

/* ============================================
   JARVIS - Agent utilities
   Bounded timeouts + abort wiring shared by the
   planner and the task engine.
   ============================================ */

function agentError(code, message) {
    const err = new Error(message);
    err.code = code;
    return err;
}

// Race a promise against a timeout and an AbortSignal. The losing promise is
// not cancelled (JS cannot cancel an arbitrary provider call), but its result
// is ignored, so a late tool/LLM response can never advance the task.
function raceBound(promise, options) {
    const opts = options || {};
    const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 30000;
    const signal = opts.signal || null;
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', onAbort);
            fn(value);
        };
        const onAbort = () => finish(reject, agentError('task_cancelled', 'Task cancelled.'));
        const timer = setTimeout(() => {
            finish(reject, agentError(opts.timeoutCode || 'timeout', opts.timeoutMessage || 'The operation timed out.'));
        }, timeoutMs);
        if (signal) {
            if (signal.aborted) {
                onAbort();
                return;
            }
            signal.addEventListener('abort', onAbort, { once: true });
        }
        Promise.resolve(promise).then(
            (value) => finish(resolve, value),
            (err) => finish(reject, err)
        );
    });
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { agentError, raceBound, sleep };
