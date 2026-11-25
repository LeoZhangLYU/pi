// Multi-sidebar state management for team and task sidebars
import { useSyncExternalStore } from "react";

const STORAGE_KEY = "pi-sidebars-state";
const listeners = new Set<() => void>();

type SidebarsState = {
	team: boolean;
	task: boolean;
	showArchived: boolean;
};

let state: SidebarsState = {
	team: false,
	task: false,
	showArchived: false,
};

// Load state from localStorage
try {
	const stored = localStorage.getItem(STORAGE_KEY);
	if (stored) {
		state = { ...state, ...JSON.parse(stored) };
	}
} catch {}

function saveState(): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
	} catch {}
	for (const listener of listeners) listener();
}

const _snapshot = () => state;

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/**
 * Check if a specific sidebar is open
 */
export function useMultiSidebarOpen(id: "team" | "task"): boolean {
	return useSyncExternalStore(
		subscribe,
		() => state[id],
		() => state[id],
	);
}

/**
 * Toggle a sidebar's open/closed state
 */
export function toggleMultiSidebar(id: "team" | "task"): void {
	state[id] = !state[id];
	saveState();
}

/**
 * Set a sidebar's open/closed state
 */
export function setMultiSidebarOpen(id: "team" | "task", open: boolean): void {
	if (state[id] === open) return;
	state[id] = open;
	saveState();
}

/**
 * Check if archived members should be shown in team sidebar
 */
export function useShowArchived(): boolean {
	return useSyncExternalStore(
		subscribe,
		() => state.showArchived,
		() => state.showArchived,
	);
}

/**
 * Toggle archived members visibility
 */
export function toggleShowArchived(): void {
	state.showArchived = !state.showArchived;
	saveState();
}

/**
 * Set archived members visibility
 */
export function setShowArchived(show: boolean): void {
	if (state.showArchived === show) return;
	state.showArchived = show;
	saveState();
}
