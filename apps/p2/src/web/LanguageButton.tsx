// The drawer's language button: follows the device's languages or picks English / Simplified Chinese. The choice is
// kept per principal in the server's LocaleChoice and mirrored to the page's cookie and localStorage.

import { LocaleChoice } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { useState } from "react";
import { Sheet, useMessages, useObject, useReadable } from "../runtime/web.tsx";
import { LanguageIcon } from "./icons.tsx";
import { rememberLanguage } from "./language.ts";
import { webMessages } from "./messages.ts";

const LANGUAGES = [
	{ tag: "en", label: "English" },
	{ tag: "zh-CN", label: "简体中文" },
] as const;

export function LanguageButton() {
	const { t } = useMessages(webMessages);
	const [open, setOpen] = useState(false);
	const choice = useObject(LocaleChoice, {});
	const pick = useReadable(choice?.pick);
	const choose = (tag: string | null): void => {
		rememberLanguage(tag);
		void choice?.choose(tag, BACKGROUND_CONTEXT).finally(() => setOpen(false));
	};
	return (
		<>
			<button
				type="button"
				className="icon-button language-toggle"
				aria-label={t("language")}
				title={t("language")}
				onClick={() => setOpen(true)}
			>
				<LanguageIcon />
			</button>
			{open && (
				<Sheet title={t("language")} onClose={() => setOpen(false)}>
					<div className="list">
						<button
							type="button"
							className="text-action"
							aria-pressed={pick === null}
							onClick={() => choose(null)}
						>
							{t("followSystem")}
						</button>
						{LANGUAGES.map(({ tag, label }) => (
							<button
								key={tag}
								type="button"
								className="text-action"
								aria-pressed={pick === tag}
								onClick={() => choose(tag)}
							>
								{label}
							</button>
						))}
					</div>
				</Sheet>
			)}
		</>
	);
}
