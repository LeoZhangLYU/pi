/**
 * 进程状态监控工具
 * 用于判断长时间运行的进程是卡死还是正常工作
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

export interface ProcessStatus {
	/** 进程是否存在 */
	exists: boolean;
	/** 进程状态 (R=Running, S=Sleeping, D=Uninterruptible, Z=Zombie, T=Stopped) */
	state?: string;
	/** CPU 使用率 (%) */
	cpuPercent?: number;
	/** 内存使用率 (%) */
	memoryPercent?: number;
	/** 已运行时间 (秒) */
	elapsedSeconds?: number;
	/** I/O 统计 */
	io?: {
		readBytes: number;
		writeBytes: number;
	};
	/** 综合判断 */
	assessment?: {
		isAlive: boolean;
		isActive: boolean;
		suspectedStuck: boolean;
		reason: string;
	};
}

/**
 * 检查进程是否存在
 */
export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * 获取进程详细状态
 */
export async function getProcessStatus(pid: number): Promise<ProcessStatus> {
	if (!isProcessAlive(pid)) {
		return { exists: false };
	}

	try {
		// 使用 ps 获取基本信息
		const psInfo = await new Promise<{
			state: string;
			cpuPercent: number;
			memoryPercent: number;
			elapsedSeconds: number;
		}>((resolve, reject) => {
			const child = spawn("ps", ["-p", String(pid), "-o", "state=,pcpu=,pmem=,etimes="]);
			let output = "";
			child.stdout?.on("data", (data) => {
				output += data.toString();
			});
			child.on("close", (code) => {
				if (code !== 0) {
					reject(new Error(`ps command failed with code ${code}`));
					return;
				}
				const parts = output.trim().split(/\s+/);
				if (parts.length >= 4) {
					resolve({
						state: parts[0]!,
						cpuPercent: parseFloat(parts[1]!),
						memoryPercent: parseFloat(parts[2]!),
						elapsedSeconds: parseInt(parts[3]!, 10),
					});
				} else {
					reject(new Error("Failed to parse ps output"));
				}
			});
			child.on("error", reject);
		});

		// 尝试获取 I/O 统计 (Linux only)
		let io: { readBytes: number; writeBytes: number } | undefined;
		if (process.platform === "linux") {
			try {
				const ioContent = await readFile(`/proc/${pid}/io`, "utf-8");
				const readMatch = ioContent.match(/read_bytes:\s*(\d+)/);
				const writeMatch = ioContent.match(/write_bytes:\s*(\d+)/);
				if (readMatch && writeMatch) {
					io = {
						readBytes: parseInt(readMatch[1]!, 10),
						writeBytes: parseInt(writeMatch[1]!, 10),
					};
				}
			} catch {
				// I/O 统计不可用（需要权限或不支持）
			}
		}

		// 综合判断进程状态
		const assessment = assessProcessStatus(psInfo.state, psInfo.cpuPercent, io);

		return {
			exists: true,
			state: psInfo.state,
			cpuPercent: psInfo.cpuPercent,
			memoryPercent: psInfo.memoryPercent,
			elapsedSeconds: psInfo.elapsedSeconds,
			io,
			assessment,
		};
	} catch (err) {
		return {
			exists: true,
			assessment: {
				isAlive: true,
				isActive: false,
				suspectedStuck: false,
				reason: `Failed to get detailed status: ${err instanceof Error ? err.message : String(err)}`,
			},
		};
	}
}

/**
 * 评估进程状态
 */
function assessProcessStatus(
	state: string,
	cpuPercent: number,
	_io?: { readBytes: number; writeBytes: number },
): ProcessStatus["assessment"] {
	const stateChar = state.charAt(0);

	// Zombie 进程
	if (stateChar === "Z") {
		return {
			isAlive: false,
			isActive: false,
			suspectedStuck: true,
			reason: "Process is a zombie (terminated but not cleaned up)",
		};
	}

	// Stopped 进程
	if (stateChar === "T") {
		return {
			isAlive: true,
			isActive: false,
			suspectedStuck: true,
			reason: "Process is stopped (paused by signal)",
		};
	}

	// Uninterruptible sleep (通常在等待 I/O)
	if (stateChar === "D") {
		return {
			isAlive: true,
			isActive: true, // 可能在等待 I/O
			suspectedStuck: false,
			reason:
				"Process is in uninterruptible sleep (waiting for I/O). " +
				"This is usually normal but if it persists for a long time, may indicate I/O issues.",
		};
	}

	// Running 或 Sleeping
	const hasCpuActivity = cpuPercent > 0.1;

	if (hasCpuActivity) {
		return {
			isAlive: true,
			isActive: true,
			suspectedStuck: false,
			reason: "Process is actively using CPU",
		};
	}

	// 无 CPU 活动
	if (stateChar === "R") {
		return {
			isAlive: true,
			isActive: true,
			suspectedStuck: false,
			reason: "Process is runnable (may be I/O bound or waiting for CPU time)",
		};
	}

	// Sleeping 且无 CPU 活动
	return {
		isAlive: true,
		isActive: false,
		suspectedStuck: false,
		reason:
			"Process is sleeping with no CPU activity. " +
			"May be waiting for I/O, network, or an event. " +
			"Check I/O statistics to determine if it's active.",
	};
}

/**
 * 监控进程状态变化
 * @param pid 进程 ID
 * @param intervalMs 检查间隔（毫秒）
 * @param callback 状态变化回调
 * @returns 停止监控的函数
 */
export function monitorProcess(pid: number, intervalMs: number, callback: (status: ProcessStatus) => void): () => void {
	let previousIo: { readBytes: number; writeBytes: number } | undefined;
	let stopped = false;

	const check = async () => {
		if (stopped) return;

		const status = await getProcessStatus(pid);

		// 检测 I/O 变化
		if (status.io && previousIo) {
			const ioActive =
				status.io.readBytes !== previousIo.readBytes || status.io.writeBytes !== previousIo.writeBytes;

			if (status.assessment && !status.assessment.isActive && ioActive) {
				status.assessment.isActive = true;
				status.assessment.reason += " (I/O activity detected)";
			}
		}

		previousIo = status.io;
		callback(status);

		if (status.exists && !stopped) {
			setTimeout(check, intervalMs);
		}
	};

	check();

	return () => {
		stopped = true;
	};
}

/**
 * 格式化进程状态为人类可读的字符串
 */
export function formatProcessStatus(status: ProcessStatus): string {
	if (!status.exists) {
		return "Process does not exist (terminated or never existed)";
	}

	const lines: string[] = [];

	lines.push(`Process Status: ${status.state || "unknown"}`);

	if (status.cpuPercent !== undefined) {
		lines.push(`CPU: ${status.cpuPercent.toFixed(1)}%`);
	}

	if (status.memoryPercent !== undefined) {
		lines.push(`Memory: ${status.memoryPercent.toFixed(1)}%`);
	}

	if (status.elapsedSeconds !== undefined) {
		const hours = Math.floor(status.elapsedSeconds / 3600);
		const minutes = Math.floor((status.elapsedSeconds % 3600) / 60);
		const seconds = status.elapsedSeconds % 60;
		lines.push(`Elapsed: ${hours}h ${minutes}m ${seconds}s`);
	}

	if (status.io) {
		lines.push(`I/O Read: ${formatBytes(status.io.readBytes)}`);
		lines.push(`I/O Write: ${formatBytes(status.io.writeBytes)}`);
	}

	if (status.assessment) {
		lines.push("");
		lines.push(`Assessment: ${status.assessment.reason}`);
		if (status.assessment.suspectedStuck) {
			lines.push("⚠️  Process may be stuck!");
		} else if (status.assessment.isActive) {
			lines.push("✅ Process appears to be working normally");
		}
	}

	return lines.join("\n");
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
