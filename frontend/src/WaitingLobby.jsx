import { useState } from "react";

/**
 * Shared "waiting for opponent" lobby used by every online game board while a
 * game sits in `waiting_for_opponent`: the join code in a dashed box with a
 * copy-to-clipboard button, the auto-start helper text, and a Cancel action.
 *
 * When an `inviteUrl` is supplied, it also renders a shareable invite link with
 * its own copy button (issue #55) — the plain code stays as a fallback.
 */
export default function WaitingLobby({ joinCode, inviteUrl, onCancel }) {
  const [copied, setCopied] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);

  async function copyToClipboard(text, setFlag) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        setFlag(true);
        setTimeout(() => setFlag(false), 2000);
      }
    } catch {
      // Clipboard unavailable (e.g. denied permission) — leave the value visible.
    }
  }

  function handleCopy() {
    copyToClipboard(joinCode, setCopied);
  }

  function handleCopyLink() {
    copyToClipboard(inviteUrl, setLinkCopied);
  }

  return (
    <div className="min-h-screen flex flex-col">
      <div className="h-1 bg-gradient-to-r from-elq-orange to-elq-orange-light" />
      <div className="flex-1 flex items-center justify-center p-4">
        <div className="text-center animate-fade-in-up">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-elq-orange/10 mb-6 animate-pulse-ring">
            <svg className="w-8 h-8 text-elq-orange animate-spin-slow" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
            </svg>
          </div>
          <h2 className="font-display text-4xl text-elq-dark mb-3">WAITING FOR OPPONENT</h2>
          <p className="text-elq-muted mb-6">Share this code with your friend</p>

          <div className="flex flex-col items-center gap-3 mb-6">
            <div className="bg-elq-bg border-2 border-dashed border-elq-orange/30 rounded-2xl px-10 py-6 select-all">
              <span className="font-mono text-5xl tracking-[0.3em] text-elq-dark font-bold">
                {joinCode}
              </span>
            </div>
            <button
              type="button"
              onClick={handleCopy}
              className="inline-flex items-center gap-2 text-sm font-semibold text-elq-muted hover:text-elq-orange transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 0 1-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 0 1 1.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 0 0-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 0 1-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 0 0-3.375-3.375h-1.5a1.125 1.125 0 0 1-1.125-1.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H9.75" />
              </svg>
              {copied ? "Copied!" : "Copy code"}
            </button>
          </div>

          {inviteUrl && (
            <div className="w-full max-w-sm mx-auto mb-6">
              <p className="text-xs font-semibold uppercase tracking-wider text-elq-muted mb-2">
                Or share an invite link
              </p>
              <div className="flex items-center gap-2 bg-elq-bg border border-elq-border rounded-xl pl-3 pr-2 py-2">
                <span
                  className="flex-1 min-w-0 truncate text-sm text-elq-muted text-left"
                  title={inviteUrl}
                >
                  {inviteUrl}
                </span>
                <button
                  type="button"
                  onClick={handleCopyLink}
                  className="inline-flex items-center gap-1.5 flex-shrink-0 text-sm font-semibold text-elq-orange hover:text-elq-orange-dark transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244" />
                  </svg>
                  {linkCopied ? "Link copied!" : "Copy link"}
                </button>
              </div>
            </div>
          )}

          <p className="text-sm text-elq-muted mb-8">
            The game will start automatically when they join.
          </p>

          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="text-sm text-elq-muted hover:text-elq-orange transition-colors underline underline-offset-2"
            >
              Cancel
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
