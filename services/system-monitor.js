/**
 * System Monitor Service
 *
 * Collects real system telemetry using os module and nvidia-smi.
 */

const os = require('os');
const { exec } = require('child_process');

class SystemMonitor {
    constructor() {
        this._interval = null;
        this._prevCpu = null;
        this._stats = {
            cpu: {
                usage: 0,
                cores: 0,
                clock: '0 GHz',
                name: os.cpus()[0]?.model || 'Unknown CPU',
                temperature: null
            },
            ram: {
                usage: 0,
                used: 0,
                total: 0,
                free: 0
            },
            gpu: {
                usage: 0,
                temperature: null,
                name: null
            },
            vram: {
                available: false,
                usage: 0,
                used: 0,
                total: 0,
                free: 0
            }
        };
    }

    /**
     * Initialize the monitor. Call once at startup.
     */
    init() {
        this._stats.cpu.cores = os.cpus().length;
        this._readCPU();
        this._readRAM();
        this._readVRAM();
    }

    /**
     * Get the current system stats snapshot.
     * @returns {object} System statistics
     */
    getStats() {
        return { ...this._stats };
    }

    /**
     * Asynchronously read the current VRAM memory-usage percentage directly
     * from nvidia-smi. Returns a fresh value rather than the (possibly stale)
     * periodic snapshot. Returns null when VRAM is not available.
     * @returns {Promise<number|null>} Memory usage percentage 0-100, or null.
     */
    async getVRAMUsagePercent() {
        try {
            const output = await new Promise((resolve, reject) => {
                exec(
                    'nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader,nounits',
                    { timeout: 5000 },
                    (error, stdout) => {
                        if (error || !stdout) return reject(error || new Error('no output'));
                        resolve(stdout);
                    }
                );
            });

            const line = String(output).trim().split('\n')[0];
            const parts = line ? line.split(',').map((s) => parseFloat(s.trim())) : [];
            const used = parts[0];
            const total = parts[1];
            if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return null;
            return Math.round((used / total) * 100);
        } catch {
            return null;
        }
    }

    /**
     * Start periodic polling.
     * @param {number} intervalMs - Polling interval in milliseconds
     */
    start(intervalMs = 2000) {
        if (this._interval) return;
        this._interval = setInterval(() => this._poll(), intervalMs);
    }

    /**
     * Stop periodic polling.
     */
    stop() {
        
        if (this._interval) {
            clearInterval(this._interval);
            this._interval = null;
        }
    }

    /**
     * Internal poll to refresh system stats.
     */
    _poll() {
        this._readCPU();
        this._readRAM();
        this._readVRAM();
    }

    /**
     * Read CPU usage by sampling os.cpus() twice and computing delta.
     */
    _readCPU() {
        const cpus = os.cpus();
        let totalIdle = 0;
        let totalTick = 0;

        for (const cpu of cpus) {
            const times = cpu.times;
            totalIdle += times.idle;
            totalTick += times.user + times.nice + times.sys + times.idle;
        }

        if (this._prevCpu) {
            const idleDelta = totalIdle - this._prevCpu.idle;
            const totalDelta = totalTick - this._prevCpu.total;
            this._stats.cpu.usage = totalDelta > 0
                ? Math.round((1 - idleDelta / totalDelta) * 100)
                : 0;
        }

        this._readCPUClock();

        this._prevCpu = { idle: totalIdle, total: totalTick };
    }

    /**
     * Read actual CPU clock speed via performance counters.
     * Uses: base clock * (% Processor Performance / 100)
     */
    _readCPUClock() {
        if (!this._baseClockMHz) {
            this._baseClockMHz = os.cpus()[0].speed || 0;
        }

        exec(
            'powershell -Command "(Get-Counter \'\\Processor Information(_Total)\\% Processor Performance\').CounterSamples.CookedValue"',
            { timeout: 5000 },
            (error, stdout) => {
                if (error || !stdout) {
                    this._stats.cpu.clock = this._baseClockMHz > 0
                        ? (this._baseClockMHz / 1000).toFixed(2) + ' GHz'
                        : 'N/A';
                    return;
                }

                const perf = parseFloat(stdout.trim());
                if (!isNaN(perf) && this._baseClockMHz > 0) {
                    const actualMHz = Math.round(this._baseClockMHz * perf / 100);
                    this._stats.cpu.clock = (actualMHz / 1000).toFixed(2) + ' GHz';
                } else {
                    this._stats.cpu.clock = this._baseClockMHz > 0
                        ? (this._baseClockMHz / 1000).toFixed(2) + ' GHz'
                        : 'N/A';
                }
            }
        );
    }

    /**
     * Read real RAM usage from os module.
     */
    _readRAM() {
        const totalBytes = os.totalmem();
        const freeBytes = os.freemem();
        const usedBytes = totalBytes - freeBytes;

        this._stats.ram.total = Math.round(totalBytes / (1024 * 1024 * 1024));
        this._stats.ram.used = Math.round(usedBytes / (1024 * 1024 * 1024) * 10) / 10;
        this._stats.ram.free = Math.round(freeBytes / (1024 * 1024 * 1024) * 10) / 10;
        this._stats.ram.usage = totalBytes > 0
            ? Math.round((usedBytes / totalBytes) * 100)
            : 0;
    }

    /**
     * Read GPU/VRAM info using nvidia-smi.
     */
    _readVRAM() {
        exec('nvidia-smi --query-gpu=name,memory.used,memory.total,utilization.gpu,temperature.gpu --format=csv,noheader,nounits', 
            { timeout: 5000 }, 
            (error, stdout) => {
                if (error || !stdout) {
                    this._stats.vram.available = false;
                    this._stats.vram.usage = 0;
                    this._stats.vram.used = 0;
                    this._stats.vram.total = 0;
                    this._stats.vram.free = 0;
                    this._stats.gpu.name = null;
                    return;
                }

                const lines = stdout.trim().split('\n');
                if (lines.length > 0) {
                    const parts = lines[0].split(',').map(s => s.trim());
                    if (parts.length >= 5) {
                        const name = parts[0];
                        const usedMB = parseFloat(parts[1]);
                        const totalMB = parseFloat(parts[2]);
                        const utilization = parseInt(parts[3], 10);
                        const temperature = parseInt(parts[4], 10);

                        this._stats.gpu.name = name;
                        this._stats.gpu.temperature = isNaN(temperature) ? null : temperature;
                        this._stats.vram.available = true;
                        this._stats.vram.total = Math.round(totalMB / 1024 * 10) / 10;
                        this._stats.vram.used = Math.round(usedMB / 1024 * 10) / 10;
                        this._stats.vram.free = Math.round((totalMB - usedMB) / 1024 * 10) / 10;
                        // Memory-usage percentage — how full the VRAM is.
                        this._stats.vram.usage = totalMB > 0
                            ? Math.round((usedMB / totalMB) * 100)
                            : 0;
                    }
                }
            }
        );
    }
}

module.exports = new SystemMonitor();