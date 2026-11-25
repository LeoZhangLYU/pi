import { filePreview } from "@p2/app/v1";
import {
	ChevronIcon,
	CloseIcon,
	type CodeLine,
	DownloadIcon,
	LinesBlock,
	Markdown,
	textLines,
	useMessages,
} from "@p2/app/v1/web";
import { useEffect, useMemo, useRef } from "react";
import { workspaceMessages } from "./messages.ts";
import type { WorkspaceResult } from "./protocol.ts";

export type FileView = "file" | "preview";
type File = Extract<WorkspaceResult, { kind: "file" }>;
function size(bytes: number): string {
	return bytes < 1024
		? `${bytes} B`
		: bytes < 1024 * 1024
			? `${(bytes / 1024).toFixed(1)} KB`
			: `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// One workspace file: File (the whole file) and Preview (rendered Markdown and media).
export function WorkspaceFile({
	path,
	view,
	views,
	file,
	error,
	url,
	wrap,
	line,
	onView,
	onWrap,
	onBack,
	closable,
}: {
	path: string;
	view: FileView;
	views: FileView[];
	file?: File;
	error?: string;
	/** Working-tree file URL for previews and download. */
	url?: string;
	wrap: boolean;
	/** Scroll to and mark this line (from tool cards). */
	line?: number;
	onView: (view: FileView) => void;
	onWrap: () => void;
	onBack: () => void;
	/** Shown beside the list it was opened from: leaving closes the file (×) rather than going back to the list. */
	closable?: boolean;
}) {
	const { t } = useMessages(workspaceMessages);
	const slash = path.lastIndexOf("/");
	const name = path.slice(slash + 1);
	const preview = filePreview(name);

	// File view: the file's plain text.
	const lines = useMemo(
		(): CodeLine[] | undefined => (view === "file" && file?.text !== undefined ? textLines(file.text) : undefined),
		[file, view],
	);
	const _numbered = (index: number) => lines?.[index]?.number;
	// Scroll a requested line into view once its content has rendered.
	const body = useRef<HTMLDivElement>(null);
	const target = line !== undefined ? lines?.findIndex((entry) => entry.kind !== "del" && entry.number === line) : -1;
	useEffect(() => {
		if (target === undefined || target < 0) return;
		body.current?.querySelectorAll(".diff-line")[target]?.scrollIntoView({ block: "center" });
	}, [target]);
	let content: React.ReactNode;
	if (error) content = <p className="notice error workspace-note">{error}</p>;
	else if (view === "preview") {
		content =
			preview?.kind === "image" ? (
				<img className="file-media" src={url} alt={name} />
			) : preview?.kind === "audio" ? (
				// biome-ignore lint/a11y/useMediaCaption: workspace files have no caption sidecar.
				<audio className="file-media" src={url} controls preload="metadata" />
			) : preview?.kind === "video" ? (
				// biome-ignore lint/a11y/useMediaCaption: workspace files have no caption sidecar.
				<video className="file-media" src={url} controls preload="metadata" playsInline />
			) : file?.text !== undefined ? (
				<div className="workspace-markdown">
					<Markdown text={file.text} />
				</div>
			) : (
				<div className="spinner large" />
			);
		content = <div className="workspace-media">{content}</div>;
	} else if (view === "file" && file?.binary) {
		content = <p className="notice workspace-note">{t("binaryFile", size(file.size))}</p>;
	} else if (!lines) content = <div className="spinner large" />;
	else if (!lines.length) content = <p className="notice workspace-note">{t("emptyFile")}</p>;
	else
		content = (
			<>
				<LinesBlock lines={lines} language={name} marked={target} />
				{view === "file" && file?.truncated && (
					<p className="notice workspace-note">{t("showingFirstMiB", size(file.size))}</p>
				)}
			</>
		);

	return (
		<div className={`workspace-view ${wrap ? "wrap" : ""}`} ref={body}>
			<div className="workspace-bars">
				<div className="workspace-bar">
					{closable ? (
						<button type="button" className="icon-button" onClick={onBack} aria-label={t("closeFile")}>
							<CloseIcon />
						</button>
					) : (
						<button type="button" className="icon-button back" onClick={onBack} aria-label={t("back")}>
							<ChevronIcon size={18} />
						</button>
					)}
					<span className="workspace-path" title={path}>
						{slash >= 0 && <span className="muted">{path.slice(0, slash + 1)}</span>}
						{name}
					</span>
					{url && (
						<a className="icon-button" href={url} download={name} aria-label={`Download ${name}`}>
							<DownloadIcon />
						</a>
					)}
				</div>
				<div className="workspace-bar secondary">
					{views.length > 1 && (
						<span className="segments workspace-views">
							{views.map((entry) => (
								<button key={entry} type="button" aria-pressed={view === entry} onClick={() => onView(entry)}>
									{{ file: t("file"), preview: t("preview") }[entry]}
								</button>
							))}
						</span>
					)}
					<span className="spacer" />
					{view !== "preview" && (
						<button
							type="button"
							className={`text-action ${wrap ? "on" : ""}`}
							aria-pressed={wrap}
							onClick={onWrap}
						>
							{t("wrap")}
						</button>
					)}
				</div>
			</div>
			{content}
		</div>
	);
}
